/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import type { Terminal } from '@xterm/xterm';
import { GlyphRenderModel } from 'browser/renderer/shared/gpu/GlyphRenderModel';
import { RectangleRenderModel } from 'browser/renderer/shared/gpu/RectangleRenderModel';
import type { IGlyphRenderer, IGpuBackend, IRectangleRenderer, IRenderModel, ITextureAtlas } from 'browser/renderer/shared/gpu/Types';
import type { IRenderDimensions } from 'browser/renderer/shared/Types';
import type { IThemeService } from 'browser/services/Services';
import { Emitter, EventUtils } from 'common/Event';
import { Disposable, MutableDisposable, toDisposable } from 'common/Lifecycle';
import type { ILogService, IOptionsService } from 'common/services/Services';
import { WebgpuContext } from './WebgpuContext';

const enum Constants {
  FLOATS_PER_GLYPH = 11,
  BYTES_PER_GLYPH = 44,
  FLOATS_PER_RECTANGLE = 8,
  BYTES_PER_RECTANGLE = 32
}

// The compiler's DOM lib has WebGPU interfaces but not the usage flag globals yet.
const enum BufferUsage {
  COPY_DST = 0x08,
  VERTEX = 0x20,
  UNIFORM = 0x40
}

class VertexBuffer extends Disposable {
  private readonly _resource = this._register(new MutableDisposable<{ buffer: GPUBuffer, dispose(): void }>());

  constructor(private readonly _device: GPUDevice, private readonly _label: string) {
    super();
  }

  public get buffer(): GPUBuffer | undefined { return this._resource.value?.buffer; }

  public ensure(byteLength: number): boolean {
    const limit = Math.floor(this._device.limits.maxBufferSize / 4) * 4;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > limit) {
      throw new RangeError(`${this._label} exceeds the WebGPU buffer size limit`);
    }
    if (this.buffer && this.buffer.size >= byteLength) {
      return false;
    }
    const size = Math.min(limit, Math.max(256, byteLength, (this.buffer?.size ?? 0) * 2));
    const buffer = this._device.createBuffer({ label: this._label, size, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this._resource.value = { buffer, dispose: () => buffer.destroy() };
    return true;
  }
}

/**
 * Per-pane WebGPU backend. All device-wide resources (pipelines, sampler,
 * empty texture and the GPU atlas texture cache) live in the shared
 * {@link WebgpuContext}; this class owns only the canvas context, vertex
 * buffers and the bind group for one terminal.
 */
export class WebgpuBackend extends Disposable implements IGpuBackend {
  public get maxTextureSize(): number { return this._context.maxTextureSize; }
  public get maxAtlasPages(): number { return this._context.maxAtlasPages; }
  private readonly _onContextLoss = this._register(new Emitter<void>());
  public readonly onContextLoss = this._onContextLoss.event;
  private readonly _canvasContext: GPUCanvasContext;
  private readonly _resolutionBuffer: GPUBuffer;
  private readonly _resolution = new Float32Array(2);
  private readonly _glyphBuffer: VertexBuffer;
  private readonly _backgroundBuffer: VertexBuffer;
  private readonly _cursorBuffer: VertexBuffer;
  private _atlas: ITextureAtlas | undefined;
  private _atlasGpuGeneration = -1;
  private _atlasBindGroup: GPUBindGroup | undefined;
  private _encoder: GPUCommandEncoder | undefined;
  private _pass: GPURenderPassEncoder | undefined;
  private _renderersCreated = false;
  private _logService: ILogService | undefined;
  private _pageOverflowWarned = false;
  private _backgroundVertices: RectangleRenderModel['backgrounds'] | undefined;
  private _backgroundVersion = -1;

  constructor(private readonly _canvas: HTMLCanvasElement, private readonly _context: WebgpuContext) {
    super();
    this._register(EventUtils.forward(this._context.onContextLoss, this._onContextLoss));
    const device = this._context.device;
    const context = _canvas.getContext('webgpu') as unknown as GPUCanvasContext | null;
    if (!context) {
      throw new Error('Could not acquire a WebGPU canvas context');
    }
    this._canvasContext = context;
    try {
      // Register cleanup before configure so a configure failure still unconfigures.
      this._register(toDisposable(() => context.unconfigure()));
      if (this.maxAtlasPages < 1 || _canvas.width > this.maxTextureSize || _canvas.height > this.maxTextureSize) {
        throw new RangeError('Canvas or atlas exceeds the WebGPU device limits');
      }
      context.configure({ device, format: this._context.format, alphaMode: 'premultiplied' });

      this._glyphBuffer = this._register(new VertexBuffer(device, 'xterm glyphs'));
      this._backgroundBuffer = this._register(new VertexBuffer(device, 'xterm backgrounds'));
      this._cursorBuffer = this._register(new VertexBuffer(device, 'xterm cursor'));
      this._resolutionBuffer = device.createBuffer({ label: 'xterm resolution', size: 8, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      this._register(toDisposable(() => this._resolutionBuffer.destroy()));
      this._register(toDisposable(() => {
        if (this._atlas) {
          this._context.releaseAtlas(this._atlas);
          this._atlas = undefined;
        }
      }));
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  public createRenderers(terminal: Terminal, dimensions: IRenderDimensions, optionsService: IOptionsService, themeService: IThemeService, logService: ILogService): { glyphRenderer: IGlyphRenderer, rectangleRenderer: IRectangleRenderer } {
    if (this._store.isDisposed || this._context.lost || this._renderersCreated) {
      throw new Error('WebGPU backend cannot create renderers in its current state');
    }
    this._logService = logService;
    const glyphRenderer = this._register(new WebgpuGlyphRenderer(this, terminal, dimensions, optionsService));
    const rectangleRenderer = this._register(new WebgpuRectangleRenderer(this, terminal, dimensions, themeService));
    this._renderersCreated = true;
    return { glyphRenderer, rectangleRenderer };
  }

  public beginRender(): void {
    if (this._store.isDisposed || this._context.lost || this._pass) {
      return;
    }
    if (!this._canvas.width || !this._canvas.height) {
      return;
    }
    if (this._canvas.width > this.maxTextureSize || this._canvas.height > this.maxTextureSize) {
      throw new RangeError('Canvas exceeds the WebGPU texture size limit');
    }
    const view = this._canvasContext.getCurrentTexture().createView();
    const encoder = this._context.device.createCommandEncoder({ label: 'xterm frame' });
    this._pass = encoder.beginRenderPass({
      label: 'xterm viewport',
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }]
    });
    this._encoder = encoder;
  }

  public endRender(): void {
    const pass = this._pass;
    const encoder = this._encoder;
    this._pass = undefined;
    this._encoder = undefined;
    if (!pass || !encoder || this._store.isDisposed || this._context.lost) {
      return;
    }
    pass.end();
    this._context.device.queue.submit([encoder.finish()]);
  }

  /**
   * Attaches this backend to `atlas`, acquiring its shared page textures from
   * the context and releasing the previously held atlas. The last owner to
   * release an atlas destroys its GPU textures.
   */
  public setAtlas(atlas: ITextureAtlas): void {
    if (this._atlas === atlas) {
      return;
    }
    if (this._atlas) {
      this._context.releaseAtlas(this._atlas);
    }
    this._atlas = atlas;
    this._context.acquireAtlas(atlas);
    this._atlasGpuGeneration = -1;
    this._atlasBindGroup = undefined;
  }

  public invalidateAtlasTextures(atlas: ITextureAtlas): void {
    this._context.invalidateAtlasTextures(atlas);
  }

  public renderGlyphs(model: GlyphRenderModel, dirtyRows: Uint8Array, dimensions: IRenderDimensions): void {
    const pass = this._pass;
    const atlas = model.atlas;
    const attributes = model.attributes;
    const width = dimensions.device.canvas.width;
    const height = dimensions.device.canvas.height;
    if (!pass || !atlas || !attributes.length || !dirtyRows.length || width <= 0 || height <= 0) {
      return;
    }
    const rowLength = attributes.length / dirtyRows.length;
    if (!Number.isInteger(rowLength) || rowLength % Constants.FLOATS_PER_GLYPH) {
      throw new RangeError('Invalid WebGPU glyph row layout');
    }
    if (this._glyphBuffer.ensure(attributes.byteLength)) {
      dirtyRows.fill(1);
    }
    if (this._atlas !== atlas) {
      this.setAtlas(atlas);
    }
    const gpu = this._context.getAtlas(atlas);
    if (this._atlasGpuGeneration !== gpu.generation) {
      this._atlasGpuGeneration = gpu.generation;
      this._atlasBindGroup = undefined;
    }
    if (atlas.pages.length > this._context.maxAtlasPages && !this._pageOverflowWarned) {
      this._pageOverflowWarned = true;
      this._logService?.warn(`Atlas page count (${atlas.pages.length}) exceeds the WebGPU texture capacity (${this._context.maxAtlasPages}); excess pages will not render`);
    }
    if (this._resolution[0] !== width || this._resolution[1] !== height) {
      this._resolution[0] = width;
      this._resolution[1] = height;
      this._context.device.queue.writeBuffer(this._resolutionBuffer, 0, this._resolution);
    }
    const buffer = this._glyphBuffer.buffer!;
    for (let y = 0; y < dirtyRows.length;) {
      if (!dirtyRows[y]) {
        y++;
        continue;
      }
      const start = y++;
      while (y < dirtyRows.length && dirtyRows[y]) {
        y++;
      }
      const byteOffset = start * rowLength * Float32Array.BYTES_PER_ELEMENT;
      const byteLength = (y - start) * rowLength * Float32Array.BYTES_PER_ELEMENT;
      this._context.device.queue.writeBuffer(buffer, byteOffset, attributes.buffer, attributes.byteOffset + byteOffset, byteLength);
      dirtyRows.fill(0, start, y);
    }
    pass.setPipeline(this._context.glyphPipeline);
    pass.setBindGroup(0, this._atlasBindGroup ??= this._createBindGroup(gpu));
    pass.setVertexBuffer(0, buffer, 0, attributes.byteLength);
    // Draw the cached grid in cell order, including unchanged rows and degenerate empty cells.
    pass.draw(4, attributes.length / Constants.FLOATS_PER_GLYPH);
  }

  public renderRectangles(vertices: RectangleRenderModel['backgrounds'], cursor: boolean): void {
    const pass = this._pass;
    if (!pass || !vertices.count) {
      return;
    }
    const byteLength = vertices.count * Constants.BYTES_PER_RECTANGLE;
    if (!Number.isSafeInteger(vertices.count) || vertices.count < 0 || byteLength > vertices.attributes.byteLength) {
      throw new RangeError('Invalid WebGPU rectangle count');
    }
    const resource = cursor ? this._cursorBuffer : this._backgroundBuffer;
    const allocated = resource.ensure(byteLength);
    const buffer = resource.buffer!;
    if (cursor || allocated || vertices !== this._backgroundVertices || vertices.version !== this._backgroundVersion) {
      this._context.device.queue.writeBuffer(buffer, 0, vertices.attributes.buffer, vertices.attributes.byteOffset, byteLength);
      if (!cursor) {
        this._backgroundVertices = vertices;
        this._backgroundVersion = vertices.version;
      }
    }
    pass.setPipeline(this._context.rectanglePipeline);
    pass.setVertexBuffer(0, buffer, 0, byteLength);
    pass.draw(4, vertices.count);
  }

  private _createBindGroup(gpu: ReturnType<WebgpuContext['getAtlas']>): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this._resolutionBuffer } },
      { binding: 1, resource: this._context.sampler }
    ];
    for (let i = 0; i < this._context.maxAtlasPages; i++) {
      entries.push({ binding: i + 2, resource: gpu.pages[i]?.view ?? this._context.emptyTextureView });
    }
    return this._context.device.createBindGroup({ label: 'xterm atlas', layout: this._context.getBindGroupLayout(), entries });
  }
}

class WebgpuGlyphRenderer extends Disposable implements IGlyphRenderer {
  private readonly _model: GlyphRenderModel;
  private _dirtyRows = new Uint8Array(0);

  constructor(private readonly _backend: WebgpuBackend, private readonly _terminal: Terminal, private _dimensions: IRenderDimensions, optionsService: IOptionsService) {
    super();
    this._model = new GlyphRenderModel(_terminal, _dimensions, optionsService);
    this.handleResize();
  }

  public beginFrame(): boolean {
    const rebuild = this._model.beginFrame();
    if (rebuild) {
      this._dirtyRows.fill(1);
    }
    return rebuild;
  }

  public updateCell(x: number, y: number, code: number, bg: number, fg: number, ext: number, chars: string, width: number, lastBg: number): void {
    this._model.updateCell(x, y, code, bg, fg, ext, chars, width, lastBg);
    this._dirtyRows[y] = 1;
  }

  public clear(): void {
    this._model.clear();
    this._markAllDirty();
  }

  public handleResize(): void {
    this._model.handleResize();
    this._markAllDirty();
  }

  private _markAllDirty(): void {
    if (this._dirtyRows.length !== this._terminal.rows) {
      this._dirtyRows = new Uint8Array(this._terminal.rows);
    }
    this._dirtyRows.fill(1);
  }

  public setDimensions(dimensions: IRenderDimensions): void {
    this._dimensions = dimensions;
    this._model.setDimensions(dimensions);
    this._dirtyRows.fill(1);
  }

  public setAtlas(atlas: ITextureAtlas): void {
    this._model.setAtlas(atlas);
    this._backend.setAtlas(atlas);
    this._dirtyRows.fill(1);
  }

  public invalidateAtlasTextures(): void {
    const atlas = this._model.atlas;
    if (atlas) {
      this._backend.invalidateAtlasTextures(atlas);
    }
  }

  public render(_renderModel: IRenderModel): void {
    if (!this._store.isDisposed) {
      this._backend.renderGlyphs(this._model, this._dirtyRows, this._dimensions);
    }
  }
}

class WebgpuRectangleRenderer extends Disposable implements IRectangleRenderer {
  private readonly _model: RectangleRenderModel;

  constructor(private readonly _backend: WebgpuBackend, terminal: Terminal, dimensions: IRenderDimensions, themeService: IThemeService) {
    super();
    this._model = this._register(new RectangleRenderModel(terminal, dimensions, themeService));
  }

  public updateBackgrounds(model: IRenderModel, startRow: number, endRow: number): void { this._model.updateBackgrounds(model, startRow, endRow); }
  public updateCursor(model: IRenderModel): void { this._model.updateCursor(model); }
  public handleResize(): void { this._model.handleResize(); }
  public setDimensions(dimensions: IRenderDimensions): void { this._model.setDimensions(dimensions); }
  public renderBackgrounds(): void {
    if (!this._store.isDisposed) {
      this._backend.renderRectangles(this._model.backgrounds, false);
    }
  }
  public renderCursor(): void {
    if (!this._store.isDisposed) {
      this._backend.renderRectangles(this._model.cursor, true);
    }
  }
}
