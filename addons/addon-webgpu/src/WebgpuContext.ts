/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import type { ITextureAtlas } from 'browser/renderer/shared/gpu/Types';
import { Emitter } from 'common/Event';
import { Disposable, toDisposable } from 'common/Lifecycle';
import { createGlyphShader, rectangleShader } from './WebgpuShaders';

const enum Constants {
  MAX_ATLAS_PAGES = 16
}

// The compiler's DOM lib has WebGPU interfaces but not the usage flag globals yet.
const enum TextureUsage {
  COPY_DST = 0x02,
  TEXTURE_BINDING = 0x04,
  // Required by queue.copyExternalImageToTexture for the destination texture.
  RENDER_ATTACHMENT = 0x10
}

interface IAtlasPageTexture {
  page: ITextureAtlas['pages'][number];
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  version: number | undefined;
  texture: GPUTexture;
  view: GPUTextureView;
  dispose(): void;
}

/** Internal knobs for the WebGPU backend; not part of the public addon API. */
export interface IWebgpuContextOptions {
  /**
   * When true (default), large incremental glyph additions upload only the
   * dirty rectangles into the existing GPU page texture via
   * copyExternalImageToTexture subrect copies instead of copying the whole
   * page. Small bursts (at or below `partialUploadThreshold` rects) still do a
   * full-page copy because a single copy call transfers the same bytes with
   * less per-call overhead. Full-page re-uploads always occur on layout changes.
   */
  partialAtlasUpload?: boolean;
  /**
   * Dirty-rect count at or below which a full-page copy is preferred over a
   * partial subrect upload. Default 32.
   */
  partialUploadThreshold?: number;
}

interface IAtlasGpuTextures {
  pages: (IAtlasPageTexture | undefined)[];
  /** Last seen atlas page layout version; a change forces a full re-upload. */
  layoutVersion: number;
  /** Bumped whenever any page texture view is created/recreated. */
  generation: number;
  /**
   * Number of backends currently holding this atlas; the last release destroys
   * the cached textures.
   */
  owners: number;
  dispose(): void;
}

/**
 * Shared, per-webview WebGPU resources: the device-owned pipelines, sampler,
 * empty fallback texture and the GPU atlas texture cache. Multiple terminals
 * share one context so a glyph atlas is uploaded to the GPU once per config and
 * sampled by every pane instead of being duplicated per terminal.
 */
export class WebgpuContext extends Disposable {
  public readonly maxTextureSize: number;
  public readonly maxAtlasPages: number;
  public readonly glyphPipeline: GPURenderPipeline;
  public readonly rectanglePipeline: GPURenderPipeline;
  public readonly sampler: GPUSampler;
  public readonly emptyTextureView: GPUTextureView;
  private readonly _onContextLoss = this._register(new Emitter<void>());
  public readonly onContextLoss = this._onContextLoss.event;
  private readonly _onError = this._register(new Emitter<Error>());
  public readonly onError = this._onError.event;
  private readonly _atlasCache = new Map<ITextureAtlas, IAtlasGpuTextures>();
  private _lost = false;

  /** Internal: use partial (dirty-rectangle) atlas uploads when true. */
  public partialAtlasUpload: boolean;
  /** Internal: dirty-rect count threshold below which a full-page copy is used. */
  public partialUploadThreshold: number;

  constructor(
    public readonly device: GPUDevice,
    public readonly format: GPUTextureFormat,
    options: IWebgpuContextOptions = {}
  ) {
    super();
    this.partialAtlasUpload = options.partialAtlasUpload ?? true;
    this.partialUploadThreshold = options.partialUploadThreshold ?? 32;
    this.maxTextureSize = device.limits.maxTextureDimension2D;
    this.maxAtlasPages = Math.min(Constants.MAX_ATLAS_PAGES, device.limits.maxSampledTexturesPerShaderStage, device.limits.maxBindingsPerBindGroup - 2);

    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
    };
    const glyphShader = device.createShaderModule({ label: 'xterm glyph shader', code: createGlyphShader(this.maxAtlasPages) });
    this.glyphPipeline = device.createRenderPipeline({
      label: 'xterm glyph pipeline',
      layout: 'auto',
      vertex: {
        module: glyphShader, entryPoint: 'vs',
        buffers: [{
          arrayStride: 44, stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
            { shaderLocation: 2, offset: 16, format: 'float32' },
            { shaderLocation: 3, offset: 20, format: 'float32x2' },
            { shaderLocation: 4, offset: 28, format: 'float32x2' },
            { shaderLocation: 5, offset: 36, format: 'float32x2' }
          ]
        }]
      },
      fragment: { module: glyphShader, entryPoint: 'fs', targets: [{ format, blend }] },
      primitive: { topology: 'triangle-strip' }
    });
    const rectShader = device.createShaderModule({ label: 'xterm rectangle shader', code: rectangleShader });
    this.rectanglePipeline = device.createRenderPipeline({
      label: 'xterm rectangle pipeline',
      layout: 'auto',
      vertex: {
        module: rectShader, entryPoint: 'vs',
        buffers: [{
          arrayStride: 32, stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
            { shaderLocation: 2, offset: 16, format: 'float32x4' }
          ]
        }]
      },
      fragment: { module: rectShader, entryPoint: 'fs', targets: [{ format, blend }] },
      primitive: { topology: 'triangle-strip' }
    });
    // Glyph quads normally map one atlas texel to one device pixel. Nearest
    // sampling makes that lookup deterministic and prevents fractional
    // positioning or backing-store correction from blending texels belonging
    // to adjacent tightly-packed glyphs.
    this.sampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const emptyTexture = device.createTexture({ label: 'xterm empty atlas page', size: [1, 1], format: 'rgba8unorm', usage: TextureUsage.TEXTURE_BINDING });
    this._register(toDisposable(() => emptyTexture.destroy()));
    this.emptyTextureView = emptyTexture.createView();

    this._register(toDisposable(() => {
      for (const entry of this._atlasCache.values()) {
        entry.dispose();
      }
      this._atlasCache.clear();
    }));

    void device.lost.then(() => {
      if (!this._store.isDisposed) {
        this._lost = true;
        this._onContextLoss.fire();
      }
    });
    const onError = (event: GPUUncapturedErrorEvent): void => {
      event.preventDefault();
      if (!this._store.isDisposed) {
        this._onError.fire(new Error(event.error.message));
      }
    };
    device.addEventListener('uncapturederror', onError);
    this._register(toDisposable(() => device.removeEventListener('uncapturederror', onError)));
  }

  public get lost(): boolean { return this._lost; }

  public getBindGroupLayout(): GPUBindGroupLayout {
    return this.glyphPipeline.getBindGroupLayout(0);
  }

  /**
   * Returns the shared GPU page textures for `atlas`, uploading changed pages.
   * The returned pages array is stable across calls; `generation` on the result
   * bumps whenever any page texture view is (re)created so per-pane bind groups
   * know when to rebuild.
   */
  public getAtlas(atlas: ITextureAtlas): IAtlasGpuTextures {
    const entry = this._ensureAtlasEntry(atlas);
    // A layout change (atlas clear or page merge) invalidates the glyph->page
    // mappings even when page objects are unchanged, so force a full re-upload.
    if (entry.layoutVersion !== atlas.pageLayoutVersion) {
      entry.layoutVersion = atlas.pageLayoutVersion;
      for (const page of entry.pages) {
        if (page) {
          page.version = undefined;
        }
      }
    }
    if (entry.pages.length !== atlas.pages.length) {
      for (let i = atlas.pages.length; i < entry.pages.length; i++) {
        entry.pages[i]?.dispose();
      }
      entry.pages.length = atlas.pages.length;
      entry.generation++;
    }
    for (let i = 0; i < atlas.pages.length; i++) {
      const page = atlas.pages[i];
      if (!page || !page.canvas.width || !page.canvas.height) {
        if (entry.pages[i]) {
          entry.pages[i]!.dispose();
          entry.pages[i] = undefined;
          entry.generation++;
        }
        continue;
      }
      const entryPage = entry.pages[i];
      if (!entryPage || entryPage.page !== page || entryPage.canvas !== page.canvas ||
          entryPage.width !== page.canvas.width || entryPage.height !== page.canvas.height) {
        if (entryPage) {
          entryPage.dispose();
        }
        if (page.canvas.width > this.maxTextureSize || page.canvas.height > this.maxTextureSize) {
          throw new RangeError('Atlas page exceeds the WebGPU texture size limit');
        }
        const texture = this.device.createTexture({
          label: `xterm atlas page ${i}`,
          size: [page.canvas.width, page.canvas.height],
          format: 'rgba8unorm',
          usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST | TextureUsage.RENDER_ATTACHMENT
        });
        entry.pages[i] = {
          page,
          canvas: page.canvas,
          width: page.canvas.width,
          height: page.canvas.height,
          version: undefined,
          texture,
          view: texture.createView(),
          dispose: () => texture.destroy()
        };
        entry.generation++;
      }
      const current = entry.pages[i]!;
      if (current.version !== page.version) {
        // Incremental version bumps upload only the dirty rectangles; a fresh
        // page (undefined version, e.g. after a layout change or new texture)
        // still does a full-page copy.
        if (this.partialAtlasUpload && current.version !== undefined) {
          this._uploadDirtyRects(current, page, atlas, i);
        } else {
          this._copyFullPage(current, page);
        }
        current.version = page.version;
      }
    }
    return entry;
  }

  private _copyFullPage(current: IAtlasPageTexture, page: ITextureAtlas['pages'][number]): void {
    this.device.queue.copyExternalImageToTexture(
      { source: page.canvas, flipY: false },
      { texture: current.texture, premultipliedAlpha: true, colorSpace: 'srgb' },
      [page.canvas.width, page.canvas.height]
    );
  }

  private _uploadDirtyRects(current: IAtlasPageTexture, page: ITextureAtlas['pages'][number], atlas: ITextureAtlas, pageIndex: number): void {
    const rects = atlas.getDirtyRects(pageIndex, current.version!);
    if (!rects.length) {
      // No tracked rects newer than our last upload; fall back to a full copy
      // rather than risk a stale texture.
      this._copyFullPage(current, page);
      return;
    }
    // HYBRID gate: for small dirty bursts a single full-page copy is cheaper
    // than many subrect copies, because every copyExternalImageToTexture call
    // carries per-call overhead while the transferred bytes are identical.
    // Only switch to the partial subrect path once a large burst makes the
    // full-page copy more expensive than the sum of its parts.
    if (this.partialUploadThreshold > 0 && rects.length <= this.partialUploadThreshold) {
      this._copyFullPage(current, page);
      return;
    }
    // Merge adjacent/overlapping rects on the same row band into single spans.
    const merged = mergeDirtyRects(rects);
    for (const rect of merged) {
      // Intersect the rect with the texture bounds so a leading-bearing glyph
      // at the page origin can never produce an out-of-range copy: the source
      // and destination origins must lie within the canvas and the texture, and
      // the copy size must keep the region inside both.
      const left = Math.max(0, rect.x);
      const top = Math.max(0, rect.y);
      const right = Math.min(rect.x + rect.width, current.width);
      const bottom = Math.min(rect.y + rect.height, current.height);
      const width = right - left;
      const height = bottom - top;
      if (width <= 0 || height <= 0) {
        continue;
      }
      try {
        // Partial and full uploads must share the same alpha and color-space
        // handling (premultipliedAlpha: true, colorSpace: 'srgb'), so the GPU
        // texture bytes are identical no matter which path wrote them. Using
        // the same source and destination origin maps the canvas region onto
        // the matching texture region.
        this.device.queue.copyExternalImageToTexture(
          { source: page.canvas, flipY: false, origin: [left, top] },
          { texture: current.texture, origin: [left, top], premultipliedAlpha: true, colorSpace: 'srgb' },
          [width, height]
        );
      } catch {
        // Never let a partial upload break rendering: fall back to the
        // full-page copy, which the version tracking below still covers.
        this._copyFullPage(current, page);
        return;
      }
    }
  }

  private _ensureAtlasEntry(atlas: ITextureAtlas): IAtlasGpuTextures {
    let entry = this._atlasCache.get(atlas);
    if (!entry) {
      const newEntry: IAtlasGpuTextures = { pages: [], layoutVersion: -1, generation: 0, owners: 0, dispose: () => { for (const p of newEntry.pages) p?.dispose(); } };
      entry = newEntry;
      this._atlasCache.set(atlas, newEntry);
    }
    return entry;
  }

  /**
   * Marks `atlas` as held by another backend, creating its shared page entry on
   * first use. Backends must call {@link releaseAtlas} when they stop using an
   * atlas (switch or dispose) so the last owner can destroy the cached GPU
   * textures instead of keeping obsolete atlases alive until the context itself
   * is disposed.
   */
  public acquireAtlas(atlas: ITextureAtlas): void {
    this._ensureAtlasEntry(atlas).owners++;
  }

  /**
   * Releases a backend-held atlas. The last release destroys the shared page
   * textures and drops the cache entry so a future acquisition starts from a
   * fresh, correctly-uploaded state.
   */
  public releaseAtlas(atlas: ITextureAtlas): void {
    const entry = this._atlasCache.get(atlas);
    if (!entry) {
      return;
    }
    entry.owners--;
    if (entry.owners <= 0) {
      this._atlasCache.delete(atlas);
      entry.dispose();
    }
  }

  /**
   * Forces a re-upload of `atlas`'s cached pages. Used after atlas merges that
   * bump the page layout version without necessarily changing page objects.
   * Only the given atlas is invalidated so unrelated shared atlases keep their
   * uploaded pages.
   */
  public invalidateAtlasTextures(atlas: ITextureAtlas): void {
    const entry = this._atlasCache.get(atlas);
    if (!entry) {
      return;
    }
    for (const page of entry.pages) {
      if (page) {
        page.version = undefined;
      }
    }
  }
}

/**
 * Merges overlapping/adjacent dirty rects that share the same row band (same
 * top and height) into single horizontal spans. This preserves the exact
 * painted pixels (no gaps are bridged) while reducing the number of
 * copyExternalImageToTexture calls for narrow glyph rects.
 */
function mergeDirtyRects(rects: ReadonlyArray<{ x: number, y: number, width: number, height: number }>): { x: number, y: number, width: number, height: number }[] {
  if (rects.length <= 1) {
    return rects.slice();
  }
  const bands = new Map<string, { y: number, height: number, rects: { start: number, end: number }[] }>();
  for (const rect of rects) {
    const key = `${rect.y}:${rect.height}`;
    let band = bands.get(key);
    if (!band) {
      band = { y: rect.y, height: rect.height, rects: [] };
      bands.set(key, band);
    }
    band.rects.push({ start: rect.x, end: rect.x + rect.width });
  }
  const result: { x: number, y: number, width: number, height: number }[] = [];
  for (const band of bands.values()) {
    band.rects.sort((a, b) => a.start - b.start);
    let current = band.rects[0];
    for (let i = 1; i < band.rects.length; i++) {
      const next = band.rects[i];
      if (next.start <= current.end) {
        current.end = Math.max(current.end, next.end);
      } else {
        result.push({ x: current.start, y: band.y, width: current.end - current.start, height: band.height });
        current = next;
      }
    }
    result.push({ x: current.start, y: band.y, width: current.end - current.start, height: band.height });
  }
  return result;
}