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

  constructor(
    public readonly device: GPUDevice,
    public readonly format: GPUTextureFormat
  ) {
    super();
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
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
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
        this.device.queue.copyExternalImageToTexture(
          { source: page.canvas, flipY: false },
          { texture: current.texture, premultipliedAlpha: true, colorSpace: 'srgb' },
          [page.canvas.width, page.canvas.height]
        );
        current.version = page.version;
      }
    }
    return entry;
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