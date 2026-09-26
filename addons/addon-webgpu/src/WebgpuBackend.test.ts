/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { Terminal } from 'browser/public/Terminal';
import { MockThemeService } from 'browser/TestUtils.test';
import { RenderModel, RenderModelConstants } from 'browser/renderer/shared/gpu/RenderModel';
import type { IDirtyRect, IGlyphRenderer, IRectangleRenderer, IRasterizedGlyph, ITextureAtlas } from 'browser/renderer/shared/gpu/Types';
import type { IRenderDimensions } from 'browser/renderer/shared/Types';
import { css } from 'common/Color';
import { Attributes } from 'common/buffer/Constants';
import { Emitter } from 'common/Event';
import { Disposable, DisposableStore, toDisposable } from 'common/Lifecycle';
import { MockLogService, MockOptionsService } from 'common/TestUtils.test';
import { WebgpuBackend } from './WebgpuBackend';
import { WebgpuContext } from './WebgpuContext';
import { createGlyphShader, rectangleShader } from './WebgpuShaders';

interface IBufferRecord {
  buffer: GPUBuffer;
  data: Uint8Array;
  destroyed: number;
}

interface ITextureRecord {
  texture: GPUTexture;
  descriptor: GPUTextureDescriptor;
  destroyed: number;
}

interface IDrawRecord {
  pipeline: string | undefined;
  buffer: GPUBuffer;
  byteLength: number;
  vertices: number;
  instances: number;
  firstInstance: number;
  submitted?: Float32Array;
}

interface ICopyRecord {
  source: Parameters<GPUQueue['copyExternalImageToTexture']>[0];
  destination: Parameters<GPUQueue['copyExternalImageToTexture']>[1];
  size: number[];
  sourceOrigin: number[];
  destinationOrigin: number[];
}

function createFakeGpu() {
  let lose!: (info: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>(resolve => lose = resolve);
  const buffers: IBufferRecord[] = [];
  const textures: ITextureRecord[] = [];
  const writes: { buffer: GPUBuffer, offset: number, byteLength: number, data: Float32Array }[] = [];
  const copies: ICopyRecord[] = [];
  const textureWrites: { texture: GPUTexture, origin: number[], size: number[], data: Uint8Array, bytesPerRow: number, rowsPerImage: number }[] = [];
  const draws: IDrawRecord[] = [];
  const viewports: number[] = [];
  const pipelines: GPURenderPipelineDescriptor[] = [];
  const bindGroups: GPUBindGroupDescriptor[] = [];
  const samplers: GPUSamplerDescriptor[] = [];
  const events: string[] = [];
  const state = { unconfigured: 0, deviceDestroyed: 0, acquired: 0, configureError: false, pipelineError: false, hasContext: true, configuration: undefined as GPUCanvasConfiguration | undefined };
  const limits = { maxTextureDimension2D: 8192, maxSampledTexturesPerShaderStage: 32, maxBindingsPerBindGroup: 1000, maxBufferSize: 1 << 20 };
  const context = {
    configure: (configuration: GPUCanvasConfiguration) => {
      state.configuration = configuration;
      if (state.configureError) {
        throw new Error('configure failed');
      }
    },
    unconfigure: () => state.unconfigured++,
    getCurrentTexture: () => {
      state.acquired++;
      return { createView: () => ({}) } as GPUTexture;
    }
  } as unknown as GPUCanvasContext;
  const canvas = {
    width: 40, height: 80,
    getContext: (type: string) => {
      assert.strictEqual(type, 'webgpu');
      return state.hasContext ? context : null;
    }
  } as unknown as HTMLCanvasElement;
  const device = {
    limits: limits as GPUSupportedLimits,
    lost,
    destroy: () => { state.deviceDestroyed++; },
    addEventListener: () => {},
    removeEventListener: () => {},
    createBuffer: (descriptor: GPUBufferDescriptor) => {
      const record: IBufferRecord = {
        buffer: { label: descriptor.label, size: descriptor.size, destroy: () => { record.destroyed++; } } as GPUBuffer,
        data: new Uint8Array(descriptor.size), destroyed: 0
      };
      buffers.push(record);
      return record.buffer;
    },
    createTexture: (descriptor: GPUTextureDescriptor) => {
      const record: ITextureRecord = {
        texture: { createView: () => ({}), destroy: () => record.destroyed++ } as unknown as GPUTexture,
        descriptor, destroyed: 0
      };
      textures.push(record);
      return record.texture;
    },
    createSampler: (descriptor: GPUSamplerDescriptor = {}) => {
      samplers.push(descriptor);
      return {} as GPUSampler;
    },
    createShaderModule: (descriptor: GPUShaderModuleDescriptor) => ({ label: descriptor.label }) as GPUShaderModule,
    createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => {
      if (state.pipelineError) {
        throw new Error('pipeline failed');
      }
      pipelines.push(descriptor);
      return { label: descriptor.label, getBindGroupLayout: () => ({}) } as unknown as GPURenderPipeline;
    },
    createBindGroup: (descriptor: GPUBindGroupDescriptor) => {
      bindGroups.push(descriptor);
      return {} as GPUBindGroup;
    },
    createCommandEncoder: () => {
      const frameDraws: IDrawRecord[] = [];
      let pipeline: GPURenderPipeline;
      let buffer: GPUBuffer;
      let byteLength: number;
      const pass = {
        setPipeline: (value: GPURenderPipeline) => pipeline = value,
        setBindGroup: () => {},
        setViewport: (x: number, y: number, width: number, height: number, _minDepth: number, _maxDepth: number) => {
          viewports.push(x, y, width, height);
        },
        setVertexBuffer: (_slot: number, value: GPUBuffer, offset: number, size: number) => {
          assert.strictEqual(offset, 0);
          assert.isAtMost(size, value.size);
          buffer = value;
          byteLength = size;
        },
        draw: (vertices: number, instances: number, _firstVertex?: number, firstInstance?: number) => {
          const draw = { pipeline: pipeline.label, buffer, byteLength, vertices, instances, firstInstance: firstInstance ?? 0 };
          frameDraws.push(draw);
          draws.push(draw);
          events.push(`draw:${buffer.label}`);
        },
        end: () => events.push('end')
      } as unknown as GPURenderPassEncoder;
      return {
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          assert.strictEqual(Array.from(descriptor.colorAttachments)[0]?.loadOp, 'clear');
          events.push('begin');
          return pass;
        },
        finish: () => ({ frameDraws, viewports })
      } as unknown as GPUCommandEncoder;
    },
    queue: {
      writeBuffer: (buffer: GPUBuffer, offset: number, data: Parameters<GPUQueue['writeBuffer']>[2], dataOffset = 0, size?: number) => {
        const view = ArrayBuffer.isView(data);
        const elementSize = view && 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
        const source = new Uint8Array(view ? data.buffer : data, (view ? data.byteOffset : 0) + dataOffset * elementSize, size === undefined ? data.byteLength - dataOffset * elementSize : size * elementSize);
        const record = buffers.find(e => e.buffer === buffer)!;
        assert.strictEqual(record.destroyed, 0);
        assert.strictEqual(offset % 4, 0);
        assert.strictEqual(source.byteLength % 4, 0);
        assert.isAtMost(offset + source.byteLength, buffer.size);
        record.data.set(source, offset);
        writes.push({ buffer, offset, byteLength: source.byteLength, data: new Float32Array(source.slice().buffer) });
        events.push(`write:${buffer.label}`);
      },
      copyExternalImageToTexture: (source: Parameters<GPUQueue['copyExternalImageToTexture']>[0], destination: Parameters<GPUQueue['copyExternalImageToTexture']>[1], copySize: GPUExtent3D) => {
        const size = Array.from(copySize as Iterable<number>);
        const sourceOrigin = Array.from((source as { origin?: Iterable<number> }).origin ?? [0, 0]);
        const destinationOrigin = Array.from((destination as { origin?: Iterable<number> }).origin ?? [0, 0]);
        assert.deepStrictEqual(sourceOrigin, destinationOrigin, 'subrect copies must use the same source and destination origin');
        const sourceCanvas = source.source as unknown as { width: number, height: number };
        assert.isAtMost(sourceOrigin[0] + size[0], sourceCanvas.width);
        assert.isAtMost(sourceOrigin[1] + size[1], sourceCanvas.height);
        copies.push({ source, destination, size: [size[0], size[1]], sourceOrigin: [sourceOrigin[0], sourceOrigin[1]], destinationOrigin: [destinationOrigin[0], destinationOrigin[1]] });
        events.push('copy');
      },
      writeTexture: (destination: { texture: GPUTexture, origin?: number[] }, data: Uint8Array, dataLayout: { offset: number, bytesPerRow: number, rowsPerImage: number }, size: number[]) => {
        textureWrites.push({ texture: destination.texture, origin: destination.origin ?? [0, 0], size, data, bytesPerRow: dataLayout.bytesPerRow, rowsPerImage: dataLayout.rowsPerImage });
        events.push('writeTexture');
      },
      submit: (commands: Iterable<GPUCommandBuffer>) => {
        for (const command of commands) {
          for (const draw of (command as unknown as { frameDraws: IDrawRecord[] }).frameDraws) {
            const record = buffers.find(e => e.buffer === draw.buffer)!;
            assert.strictEqual(record.destroyed, 0);
            draw.submitted = new Float32Array(record.data.slice(0, draw.byteLength).buffer);
          }
        }
        events.push('submit');
      }
    } as unknown as GPUQueue
  } satisfies Pick<GPUDevice, 'limits' | 'lost' | 'destroy' | 'addEventListener' | 'removeEventListener' | 'createBuffer' | 'createTexture' | 'createSampler' | 'createShaderModule' | 'createRenderPipeline' | 'createBindGroup' | 'createCommandEncoder' | 'queue'>;
  return { device: device as unknown as GPUDevice, canvas, state, limits, buffers, textures, writes, copies, textureWrites, draws, viewports, pipelines, bindGroups, samplers, events, lose };
}

interface ITestAtlasPage {
  canvas: HTMLCanvasElement;
  version: number;
  dirtyRects: { x: number, y: number, width: number, height: number, version: number }[];
}

function fakeCanvas(width = 64, height = 64): HTMLCanvasElement {
  return {
    width, height,
    getContext: () => null
  } as unknown as HTMLCanvasElement;
}

class TestAtlas extends Disposable implements ITextureAtlas {
  public readonly pages: ITestAtlasPage[] = [
    { canvas: fakeCanvas(), version: 1, dirtyRects: [] },
    { canvas: fakeCanvas(), version: 1, dirtyRects: [] }
  ];
  public pageLayoutVersion = 0;
  public readonly onAddTextureAtlasCanvas = this._register(new Emitter<HTMLCanvasElement>()).event;
  public readonly onRemoveTextureAtlasCanvas = this._register(new Emitter<HTMLCanvasElement>()).event;
  public warmUp(): void {}
  public clearTexture(): void {}
  public getDirtyRects(pageIndex: number, lastVersion: number): ReadonlyArray<IDirtyRect> {
    const page = this.pages[pageIndex];
    if (!page) {
      return [];
    }
    const result: IDirtyRect[] = [];
    for (const rect of page.dirtyRects) {
      if (rect.version > lastVersion) {
        result.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
    }
    return result;
  }
  public getRasterizedGlyph(code: number): IRasterizedGlyph {
    return {
      offset: { x: 0, y: 0 }, size: { x: 10, y: 20 },
      texturePage: code % 2, texturePosition: { x: 0, y: 0 },
      texturePositionClipSpace: { x: 0, y: 0 }, sizeClipSpace: { x: 10 / 64, y: 20 / 64 }
    };
  }
  public getRasterizedGlyphCombinedChar(): IRasterizedGlyph { return this.getRasterizedGlyph(0); }
}

describe('WebgpuBackend', () => {
  let store: DisposableStore;
  let gpu: ReturnType<typeof createFakeGpu>;
  let context: WebgpuContext;
  let backend: WebgpuBackend;
  let terminal: Terminal;
  let dimensions: IRenderDimensions;
  let atlas: TestAtlas;
  let model: RenderModel;
  let glyphRenderer: IGlyphRenderer;
  let rectangleRenderer: IRectangleRenderer;
  let theme: MockThemeService;
  let themeChanges: Emitter<MockThemeService['colors']>;

  beforeEach(() => {
    store = new DisposableStore();
    for (const [name, value] of [
      ['GPUBufferUsage', { COPY_DST: 8, VERTEX: 32, UNIFORM: 64 }],
      ['GPUTextureUsage', { COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 }]
    ] as const) {
      const original = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, value });
      store.add(toDisposable(() => {
        if (original) {
          Object.defineProperty(globalThis, name, original);
        } else {
          Reflect.deleteProperty(globalThis, name);
        }
      }));
    }
    gpu = createFakeGpu();
    context = store.add(new WebgpuContext(gpu.device, 'bgra8unorm'));
    // Force the partial subrect copy path for small bursts in these unit tests;
    // the hybrid threshold is exercised by its own dedicated test below.
    context.partialUploadThreshold = 0;
    backend = store.add(new WebgpuBackend(gpu.canvas, context));
    terminal = store.add(new Terminal({ cols: 4, rows: 4 }));
    dimensions = {
      css: { canvas: { width: 40, height: 80 }, cell: { width: 10, height: 20 } },
      device: { canvas: { width: 40, height: 80 }, cell: { width: 10, height: 20 }, char: { width: 10, height: 20, left: 0, top: 0 } }
    };
    theme = new MockThemeService();
    themeChanges = store.add(new Emitter<MockThemeService['colors']>());
    theme.onChangeColors = themeChanges.event;
    theme.colors = { ...theme.colors, cursor: css.toColor('#ffffff') };
    ({ glyphRenderer, rectangleRenderer } = backend.createRenderers(terminal, dimensions, new MockOptionsService(), theme, new MockLogService()));
    atlas = store.add(new TestAtlas());
    glyphRenderer.setAtlas(atlas);
    glyphRenderer.beginFrame();
    model = new RenderModel();
    model.resize(terminal.cols, terminal.rows);
    rectangleRenderer.handleResize();
    rectangleRenderer.updateBackgrounds(model, 0, terminal.rows - 1);
  });

  afterEach(() => store.dispose());

  function frame(): void {
    backend.beginRender(dimensions);
    rectangleRenderer.renderBackgrounds();
    glyphRenderer.render(model);
    rectangleRenderer.renderCursor();
    backend.endRender();
  }

  function update(x: number, y: number, code = 65): void {
    glyphRenderer.updateCell(x, y, code, 0, 0, 0, String.fromCharCode(code), 1, 0);
    // Mirror GpuRenderer._updateModel: lineLengths tracks the last used cell per
    // row and drives the per-row glyph draws.
    model.lineLengths[y] = Math.max(model.lineLengths[y], x + 1);
  }

  function glyphWrites() {
    return gpu.writes.filter(e => e.buffer.label === 'xterm glyphs');
  }

  it('configures premultiplied alpha and caps separately bound atlas textures', () => {
    assert.strictEqual(gpu.state.configuration?.alphaMode, 'premultiplied');
    assert.strictEqual(backend.maxAtlasPages, 16);
    assert.strictEqual(backend.maxTextureSize, 8192);
    assert.deepInclude(gpu.samplers[0], {
      minFilter: 'nearest',
      magFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    });
    for (const pipeline of gpu.pipelines) {
      assert.strictEqual(pipeline.primitive?.topology, 'triangle-strip');
      assert.deepStrictEqual(Array.from(pipeline.fragment!.targets)[0]?.blend, {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
      });
    }
    frame();
    assert.strictEqual(Array.from(gpu.bindGroups[0].entries).length, 1);
    assert.strictEqual(Array.from(gpu.bindGroups[1].entries).length, 18);
    for (const copy of gpu.copies) {
      assert.strictEqual(copy.source.flipY, false);
      assert.strictEqual(copy.destination.premultipliedAlpha, true);
      assert.strictEqual(copy.destination.colorSpace, 'srgb');
    }
  });

  function resolutionUniform(): Float32Array {
    return gpu.writes.find(e => e.buffer.label === 'xterm resolution')!.data;
  }

  it('renders into the exact intended viewport when the backing store fits the grid', () => {
    frame();
    assert.deepStrictEqual(gpu.viewports, [0, 0, 40, 80]);
    assert.deepStrictEqual(Array.from(resolutionUniform()), [40, 80, 1, 1]);
  });

  it('keeps the intended viewport when the backing store is larger than the grid', () => {
    gpu.canvas.width = 41;
    gpu.canvas.height = 81;
    frame();
    assert.deepStrictEqual(gpu.viewports, [0, 0, 40, 80]);
    assert.deepStrictEqual(Array.from(resolutionUniform()), [40, 80, 1, 1]);
  });

  it('falls back to the backing store with a compensated scale when it is smaller than the grid', () => {
    gpu.canvas.width = 39;
    gpu.canvas.height = 79;
    update(3, 0);
    frame();
    assert.deepStrictEqual(gpu.viewports, [0, 0, 39, 79]);
    const uniform = Array.from(resolutionUniform());
    assert.strictEqual(uniform[0], 39);
    assert.strictEqual(uniform[1], 79);
    assert.closeTo(uniform[2], 40 / 39, 1e-6);
    assert.closeTo(uniform[3], 80 / 79, 1e-6);
    // Geometry stays grid-normalized; viewport.zw compensates in the shader.
    const glyph = gpu.draws.find(e => e.buffer.label === 'xterm glyphs')!;
    assert.strictEqual(glyph.submitted![42], 3 / 4);
    assert.strictEqual(glyph.submitted![35], 10 / 40);
  });

  it('does not re-upload the viewport uniform when the backing or grid is unchanged', () => {
    gpu.canvas.width = 39;
    gpu.canvas.height = 79;
    frame();
    const count = gpu.writes.filter(e => e.buffer.label === 'xterm resolution').length;
    frame();
    assert.strictEqual(gpu.writes.filter(e => e.buffer.label === 'xterm resolution').length, count, 'unchanged frames must not re-upload the uniform');
    gpu.canvas.width = 40;
    frame();
    assert.strictEqual(gpu.writes.filter(e => e.buffer.label === 'xterm resolution').length, count + 1, 'a changed backing must upload exactly once');
  });

  it('keeps the viewport within the attachment and the grid stretch-free across font/DPI dimensions', () => {
    for (const [gridWidth, gridHeight, backingWidth, backingHeight] of [
      [567, 324, 568, 325],
      [567, 324, 566, 323],
      [560, 340, 560, 340],
      [1024, 640, 1023, 641]
    ] as const) {
      dimensions.device.canvas.width = gridWidth;
      dimensions.device.canvas.height = gridHeight;
      gpu.canvas.width = backingWidth;
      gpu.canvas.height = backingHeight;
      gpu.writes.length = 0;
      gpu.viewports.length = 0;
      backend.beginRender(dimensions);
      backend.endRender();
      const [vpW, vpH, scaleX, scaleY] = Array.from(resolutionUniform());
      assert.isAtMost(vpW, backingWidth, 'viewport must stay within the attachment');
      assert.isAtMost(vpH, backingHeight, 'viewport must stay within the attachment');
      assert.closeTo(vpW * scaleX, gridWidth, 1e-3, 'viewport * scale must reproduce the grid without stretching');
      assert.closeTo(vpH * scaleY, gridHeight, 1e-3, 'viewport * scale must reproduce the grid without stretching');
      assert.deepStrictEqual(gpu.viewports, [0, 0, vpW, vpH]);
    }
  });

  it('uses the device sampled texture limit when it is below the cap', () => {
    const smaller = createFakeGpu();
    smaller.limits.maxSampledTexturesPerShaderStage = 4;
    const limited = store.add(new WebgpuBackend(smaller.canvas, store.add(new WebgpuContext(smaller.device, 'bgra8unorm'))));
    assert.strictEqual(limited.maxAtlasPages, 4);
  });

  it('shares atlas GPU textures across backends on one context', () => {
    const theme = new MockThemeService();
    theme.colors = { ...theme.colors, cursor: css.toColor('#ffffff') };
    const second = store.add(new WebgpuBackend(gpu.canvas, context));
    const { glyphRenderer: glyphB } = second.createRenderers(terminal, dimensions, new MockOptionsService(), theme, new MockLogService());
    glyphB.setAtlas(atlas);
    glyphB.beginFrame();
    backend.beginRender(dimensions);
    glyphRenderer.render(model);
    backend.endRender();
    const copiesAfterFirst = gpu.copies.length;
    const texturesAfterFirst = gpu.textures.length;
    const bindGroupsAfterFirst = gpu.bindGroups.length;
    second.beginRender(dimensions);
    glyphB.render(model);
    second.endRender();
    assert.strictEqual(gpu.copies.length, copiesAfterFirst);
    assert.strictEqual(gpu.textures.length, texturesAfterFirst);
    assert.strictEqual(gpu.bindGroups.length, bindGroupsAfterFirst + 1);
  });

  it('does not re-upload shared pages when a backend attaches late', () => {
    frame();
    const copies = gpu.copies.length;
    const textures = gpu.textures.length;
    const theme = new MockThemeService();
    theme.colors = { ...theme.colors, cursor: css.toColor('#ffffff') };
    const second = store.add(new WebgpuBackend(gpu.canvas, context));
    const { glyphRenderer: glyphB } = second.createRenderers(terminal, dimensions, new MockOptionsService(), theme, new MockLogService());
    glyphB.setAtlas(atlas);
    glyphB.beginFrame();
    second.beginRender(dimensions);
    glyphB.render(model);
    second.endRender();
    assert.strictEqual(gpu.copies.length, copies);
    assert.strictEqual(gpu.textures.length, textures);
    assert.strictEqual(gpu.textureWrites.length, 0);
  });

  it('keeps shared page textures alive while another backend still owns the atlas', () => {
    frame();
    const pages = gpu.textures.slice(1);
    const theme = new MockThemeService();
    theme.colors = { ...theme.colors, cursor: css.toColor('#ffffff') };
    const second = store.add(new WebgpuBackend(gpu.canvas, context));
    const { glyphRenderer: glyphB } = second.createRenderers(terminal, dimensions, new MockOptionsService(), theme, new MockLogService());
    glyphB.setAtlas(atlas);
    glyphB.beginFrame();
    backend.dispose();
    assert.strictEqual(pages[0].destroyed, 0);
    assert.strictEqual(pages[1].destroyed, 0);
    gpu.copies.length = 0;
    second.beginRender(dimensions);
    glyphB.render(model);
    second.endRender();
    assert.strictEqual(gpu.copies.length, 0);
    second.dispose();
    assert.strictEqual(pages[0].destroyed, 1);
    assert.strictEqual(pages[1].destroyed, 1);
    const third = store.add(new WebgpuBackend(gpu.canvas, context));
    const { glyphRenderer: glyphC } = third.createRenderers(terminal, dimensions, new MockOptionsService(), theme, new MockLogService());
    glyphC.setAtlas(atlas);
    glyphC.beginFrame();
    gpu.copies.length = 0;
    third.beginRender(dimensions);
    glyphC.render(model);
    third.endRender();
    assert.strictEqual(gpu.copies.length, 2);
    assert.strictEqual(pages[0].destroyed, 1);
    assert.strictEqual(pages[1].destroyed, 1);
  });

  it('destroys shared page textures when the sole owner releases the atlas', () => {
    frame();
    const pages = gpu.textures.slice(1);
    backend.dispose();
    assert.strictEqual(pages[0].destroyed, 1);
    assert.strictEqual(pages[1].destroyed, 1);
  });

  it('releases and destroys the previous atlas when a sole owner switches atlases', () => {
    frame();
    const pages = gpu.textures.slice(1);
    const replacement = store.add(new TestAtlas());
    glyphRenderer.setAtlas(replacement);
    assert.strictEqual(pages[0].destroyed, 1);
    assert.strictEqual(pages[1].destroyed, 1);
    gpu.copies.length = 0;
    glyphRenderer.beginFrame();
    frame();
    assert.strictEqual(gpu.copies.length, 2);
  });

  it('invalidates only the refreshed atlas and leaves unrelated atlases alone', () => {
    frame();
    const theme = new MockThemeService();
    theme.colors = { ...theme.colors, cursor: css.toColor('#ffffff') };
    const second = store.add(new WebgpuBackend(gpu.canvas, context));
    const { glyphRenderer: glyphB } = second.createRenderers(terminal, dimensions, new MockOptionsService(), theme, new MockLogService());
    const otherAtlas = store.add(new TestAtlas());
    glyphB.setAtlas(otherAtlas);
    glyphB.beginFrame();
    second.beginRender(dimensions);
    glyphB.render(model);
    second.endRender();
    gpu.copies.length = 0;
    glyphRenderer.invalidateAtlasTextures();
    frame();
    assert.strictEqual(gpu.copies.length, 2);
    assert.deepStrictEqual(gpu.copies.map(e => e.source.source), [atlas.pages[0].canvas, atlas.pages[1].canvas]);
    second.beginRender(dimensions);
    glyphB.render(model);
    second.endRender();
    assert.strictEqual(gpu.copies.length, 2);
  });

  it('records one ordered pass with distinct background and cursor buffers', () => {
    update(0, 0);
    model.cursor = { x: 2, y: 1, width: 1, style: 'bar', cursorWidth: 1, dpr: 1 };
    rectangleRenderer.updateCursor(model);
    frame();
    assert.deepStrictEqual(gpu.draws.map(e => e.buffer.label), ['xterm backgrounds', 'xterm glyphs', 'xterm cursor']);
    assert.deepStrictEqual(gpu.events.filter(e => e === 'begin' || e === 'end' || e === 'submit'), ['begin', 'end', 'submit']);
    assert.ok(gpu.draws[0].buffer !== gpu.draws[2].buffer);
    assert.deepStrictEqual(Array.from(gpu.draws[0].submitted!.slice(0, 4)), [0, 0, 1, 1]);
    assert.strictEqual(gpu.draws[2].submitted![0], 0.5);
    assert.isAbove(gpu.events.indexOf('copy'), gpu.events.indexOf('begin'));
    assert.isBelow(gpu.events.indexOf('copy'), gpu.events.indexOf('submit'));
  });

  it('preserves alternating atlas page order in a single full viewport draw', () => {
    for (let x = 0; x < 4; x++) {
      update(x, 0, 65 + x);
    }
    frame();
    const draw = gpu.draws.find(e => e.buffer.label === 'xterm glyphs')!;
    assert.strictEqual(draw.vertices, 4);
    assert.strictEqual(draw.instances, model.lineLengths[0]);
    assert.deepStrictEqual([0, 1, 2, 3].map(x => draw.submitted![x * 11 + 4]), [1, 0, 1, 0]);
    assert.deepStrictEqual([0, 1, 2, 3].map(x => draw.submitted![x * 11 + 9]), [0, 0.25, 0.5, 0.75]);
  });

  it('reuses GPU resources and redraws cached rows without glyph or atlas uploads', () => {
    update(0, 0);
    frame();
    const bufferCount = gpu.buffers.length;
    const textureCount = gpu.textures.length;
    const bindGroupCount = gpu.bindGroups.length;
    gpu.writes.length = 0;
    gpu.copies.length = 0;
    gpu.draws.length = 0;
    assert.strictEqual(glyphRenderer.beginFrame(), false);
    frame();
    assert.strictEqual(glyphWrites().length, 0);
    assert.strictEqual(gpu.copies.length, 0);
    assert.strictEqual(gpu.buffers.length, bufferCount);
    assert.strictEqual(gpu.textures.length, textureCount);
    assert.strictEqual(gpu.bindGroups.length, bindGroupCount);
    assert.strictEqual(gpu.draws.find(e => e.buffer.label === 'xterm glyphs')!.instances, model.lineLengths[0]);
  });

  it('coalesces adjacent dirty rows without per-cell GPU calls', () => {
    frame();
    gpu.writes.length = 0;
    update(0, 1);
    update(1, 1);
    update(0, 2);
    assert.strictEqual(gpu.writes.length, 0);
    frame();
    assert.deepStrictEqual(glyphWrites().map(e => [e.offset, e.byteLength]), [[4 * 44, 2 * 4 * 44]]);
    gpu.writes.length = 0;
    update(0, 0);
    update(0, 3);
    frame();
    assert.deepStrictEqual(glyphWrites().map(e => [e.offset, e.byteLength]), [[0, 4 * 44], [3 * 4 * 44, 4 * 44]]);
  });

  function glyphDraws() {
    return gpu.draws.filter(e => e.buffer.label === 'xterm glyphs');
  }

  it('draws a dense full grid as one coalesced draw', () => {
    for (let y = 0; y < terminal.rows; y++) {
      for (let x = 0; x < terminal.cols; x++) {
        update(x, y);
      }
    }
    frame();
    assert.deepStrictEqual(glyphDraws().map(d => [d.instances, d.firstInstance]), [[terminal.rows * terminal.cols, 0]]);
  });

  it('coalesces contiguous full rows but keeps partial rows as separate draws', () => {
    glyphRenderer.clear();
    for (let x = 0; x < terminal.cols; x++) {
      update(x, 0);
      update(x, 1);
    }
    update(0, 2);
    update(1, 2);
    model.lineLengths[2] = 2;
    frame();
    assert.deepStrictEqual(glyphDraws().map(d => [d.instances, d.firstInstance]), [[8, 0], [2, 8]]);
  });

  it('draws sparse rows individually with gaps excluded', () => {
    glyphRenderer.clear();
    for (let x = 0; x < terminal.cols; x++) {
      update(x, 0);
      update(x, 3);
    }
    update(0, 2);
    update(1, 2);
    model.lineLengths[1] = 0;
    model.lineLengths[2] = 2;
    frame();
    assert.deepStrictEqual(glyphDraws().map(d => [d.instances, d.firstInstance]), [[4, 0], [2, 8], [4, 12]]);
  });

  it('keeps uploads zero on unchanged frames while coalesced draws still issue', () => {
    for (let y = 0; y < terminal.rows; y++) {
      for (let x = 0; x < terminal.cols; x++) {
        update(x, y);
      }
    }
    frame();
    assert.isAbove(glyphWrites().length, 0);
    gpu.writes.length = 0;
    gpu.copies.length = 0;
    gpu.draws.length = 0;
    assert.strictEqual(glyphRenderer.beginFrame(), false);
    frame();
    assert.strictEqual(glyphWrites().length, 0);
    assert.strictEqual(gpu.copies.length, 0);
    assert.deepStrictEqual(glyphDraws().map(d => [d.instances, d.firstInstance]), [[terminal.rows * terminal.cols, 0]]);
  });

  it('redraws unchanged backgrounds without uploads, including cursor-only frames', () => {
    frame();
    gpu.writes.length = 0;
    gpu.draws.length = 0;
    for (let x = 0; x < 4; x++) {
      model.cursor = { x, y: 0, width: 1, style: 'bar', cursorWidth: 1, dpr: 1 };
      rectangleRenderer.updateCursor(model);
      frame();
    }
    assert.strictEqual(gpu.writes.filter(e => e.buffer.label === 'xterm backgrounds').length, 0);
    assert.strictEqual(gpu.draws.filter(e => e.buffer.label === 'xterm backgrounds').length, 4);
    assert.strictEqual(gpu.writes.filter(e => e.buffer.label === 'xterm cursor').length, 4);
  });

  it('uploads backgrounds after dirty rows, theme changes and resize, retaining skipped updates', () => {
    frame();
    for (const change of [
      () => {
        model.cells[RenderModelConstants.BG_OFFSET] = Attributes.CM_RGB | 0x0000ff;
        rectangleRenderer.updateBackgrounds(model, 0, 0);
      },
      () => {
        theme.colors = { ...theme.colors, background: css.toColor('#ff0000') };
        themeChanges.fire(theme.colors);
      },
      () => {
        dimensions.device.canvas.width = 80;
        rectangleRenderer.setDimensions(dimensions);
        rectangleRenderer.handleResize();
        rectangleRenderer.updateBackgrounds(model, 0, terminal.rows - 1);
      }
    ]) {
      gpu.writes.length = 0;
      change();
      gpu.canvas.width = 0;
      frame();
      assert.strictEqual(gpu.writes.length, 0);
      gpu.canvas.width = dimensions.device.canvas.width;
      frame();
      const writes = gpu.writes.filter(e => e.buffer.label === 'xterm backgrounds');
      assert.strictEqual(writes.length, 1);
      const draws = gpu.draws.filter(e => e.buffer.label === 'xterm backgrounds');
      assert.deepStrictEqual(draws[draws.length - 1].submitted, writes[0].data);
      frame();
      assert.strictEqual(gpu.writes.filter(e => e.buffer.label === 'xterm backgrounds').length, 1);
    }
    const writes = gpu.writes.filter(e => e.buffer.label === 'xterm backgrounds');
    assert.deepStrictEqual(Array.from(writes[0].data.slice(0, 8)), [0, 0, 0.5, 1, 1, 0, 0, 1]);
    assert.deepStrictEqual(Array.from(writes[0].data.slice(8, 16)), [0, 0, 0.125, 0.25, 0, 0, 1, 1]);
  });

  it('uploads cleared cells and the whole grid after clear or resize', () => {
    update(0, 1);
    frame();
    gpu.writes.length = 0;
    update(0, 1, 0);
    frame();
    assert.strictEqual(glyphWrites()[0].data[2], 0);
    gpu.writes.length = 0;
    glyphRenderer.clear();
    frame();
    assert.deepStrictEqual(glyphWrites().map(e => [e.offset, e.byteLength]), [[0, 16 * 44]]);
    const oldBuffer = gpu.buffers.find(e => e.buffer.label === 'xterm glyphs')!;
    terminal.resize(8, 4);
    glyphRenderer.handleResize();
    gpu.writes.length = 0;
    frame();
    assert.strictEqual(oldBuffer.destroyed, 1);
    assert.deepStrictEqual(glyphWrites().map(e => [e.offset, e.byteLength]), [[0, 32 * 44]]);
  });

  it('uploads only changed atlas pages without recreating textures or bind groups', () => {
    frame();
    const textureCount = gpu.textures.length;
    const bindGroupCount = gpu.bindGroups.length;
    gpu.copies.length = 0;
    atlas.pages[1].version++;
    frame();
    assert.strictEqual(gpu.copies.length, 1);
    assert.strictEqual(gpu.copies[0].source.source, atlas.pages[1].canvas);
    assert.strictEqual(gpu.textures.length, textureCount);
    assert.strictEqual(gpu.bindGroups.length, bindGroupCount);
  });

  it('uploads only the dirty rect via a copyExternalImageToTexture subrect with full-page alpha semantics', () => {
    const pageCanvas = fakeCanvas(64, 64);
    const page = atlas.pages[1] as ITestAtlasPage;
    page.canvas = pageCanvas;
    frame();
    const pageTexture = gpu.textures[2].texture;
    gpu.copies.length = 0;
    gpu.textureWrites.length = 0;
    const base = page.version;
    page.dirtyRects = [{ x: 5, y: 7, width: 10, height: 20, version: base + 1 }];
    page.version = base + 1;
    frame();
    assert.strictEqual(gpu.copies.length, 1);
    assert.strictEqual(gpu.textureWrites.length, 0);
    const copy = gpu.copies[0];
    assert.strictEqual(copy.source.source, pageCanvas);
    assert.deepStrictEqual(copy.sourceOrigin, [5, 7]);
    assert.deepStrictEqual(copy.destinationOrigin, [5, 7]);
    assert.deepStrictEqual(copy.size, [10, 20]);
    assert.strictEqual(copy.destination.texture, pageTexture);
    assert.strictEqual(copy.source.flipY, false);
    assert.strictEqual(copy.destination.premultipliedAlpha, true);
    assert.strictEqual(copy.destination.colorSpace, 'srgb');
  });

  it('uploads each dirty rect once for a burst of glyph insertions', () => {
    const page = atlas.pages[0] as ITestAtlasPage;
    page.canvas = fakeCanvas(128, 128);
    frame();
    gpu.copies.length = 0;
    gpu.textureWrites.length = 0;
    const base = page.version;
    page.dirtyRects = [
      { x: 0, y: 0, width: 10, height: 20, version: base + 1 },
      { x: 20, y: 30, width: 10, height: 20, version: base + 2 },
      { x: 40, y: 50, width: 10, height: 20, version: base + 3 }
    ];
    page.version = base + 3;
    frame();
    assert.strictEqual(gpu.copies.length, 3);
    assert.strictEqual(gpu.textureWrites.length, 0);
    assert.deepStrictEqual(gpu.copies.map(c => c.sourceOrigin), [[0, 0], [20, 30], [40, 50]]);
    assert.deepStrictEqual(gpu.copies.map(c => c.destinationOrigin), [[0, 0], [20, 30], [40, 50]]);
    assert.deepStrictEqual(gpu.copies.map(c => c.size), [[10, 20], [10, 20], [10, 20]]);
  });

  it('clamps dirty rects to the page bounds so a leading-bearing glyph at the origin never yields a negative copy origin', () => {
    const page = atlas.pages[0] as ITestAtlasPage;
    page.canvas = fakeCanvas();
    frame();
    gpu.copies.length = 0;
    gpu.textureWrites.length = 0;
    const base = page.version;
    // Simulates a glyph packed at texturePosition (0,0) with a 2px left and 1px
    // top bearing: putImageData clips the paint to (0,0) with size 8x19.
    page.dirtyRects = [{ x: -2, y: -1, width: 10, height: 20, version: base + 1 }];
    page.version = base + 1;
    frame();
    assert.strictEqual(gpu.copies.length, 1);
    assert.strictEqual(gpu.textureWrites.length, 0);
    assert.deepStrictEqual(gpu.copies[0].sourceOrigin, [0, 0]);
    assert.deepStrictEqual(gpu.copies[0].destinationOrigin, [0, 0]);
    assert.deepStrictEqual(gpu.copies[0].size, [8, 19]);
  });

  it('skips dirty rects that fall entirely outside the page', () => {
    const page = atlas.pages[0] as ITestAtlasPage;
    page.canvas = fakeCanvas();
    frame();
    gpu.copies.length = 0;
    gpu.textureWrites.length = 0;
    const base = page.version;
    page.dirtyRects = [{ x: -30, y: 0, width: 10, height: 20, version: base + 1 }];
    page.version = base + 1;
    frame();
    assert.strictEqual(gpu.copies.length, 0);
    assert.strictEqual(gpu.textureWrites.length, 0);
  });

  it('produces no writes on a second frame with no changes', () => {
    frame();
    gpu.copies.length = 0;
    gpu.textureWrites.length = 0;
    frame();
    assert.strictEqual(gpu.copies.length, 0);
    assert.strictEqual(gpu.textureWrites.length, 0);
  });

  it('still triggers a full-page copy on a layout version change', () => {
    frame();
    gpu.copies.length = 0;
    gpu.textureWrites.length = 0;
    atlas.pageLayoutVersion++;
    glyphRenderer.beginFrame();
    frame();
    assert.strictEqual(gpu.copies.length, 2);
    assert.strictEqual(gpu.textureWrites.length, 0);
  });

  it('hybrid gate: small dirty bursts use a full-page copy, large bursts use subrect copies', () => {
    // Fresh context with the default threshold (32).
    const hybridContext = store.add(new WebgpuContext(gpu.device, 'bgra8unorm'));
    const hybridBackend = store.add(new WebgpuBackend(gpu.canvas, hybridContext));
    const { glyphRenderer: glyphH } = hybridBackend.createRenderers(terminal, dimensions, new MockOptionsService(), theme, new MockLogService());
    const page = atlas.pages[0] as ITestAtlasPage;
    page.canvas = fakeCanvas(256, 256);
    glyphH.setAtlas(atlas);
    glyphH.beginFrame();
    hybridBackend.beginRender(dimensions);
    glyphH.render(model);
    hybridBackend.endRender();
    gpu.copies.length = 0;
    gpu.textureWrites.length = 0;

    // Small burst (1 rect) must take the full-copy path (no partial subrects).
    const base = page.version;
    page.dirtyRects = [{ x: 0, y: 0, width: 10, height: 20, version: base + 1 }];
    page.version = base + 1;
    glyphH.beginFrame();
    hybridBackend.beginRender(dimensions);
    glyphH.render(model);
    hybridBackend.endRender();
    assert.strictEqual(gpu.copies.length, 1, 'small burst should use a full-page copy');
    assert.deepStrictEqual(gpu.copies[0].size, [256, 256], 'small burst copy must cover the full page');
    assert.strictEqual(gpu.textureWrites.length, 0, 'small burst must not use writeTexture');

    // Large burst (>32 rects) must use the partial subrect copy path.
    gpu.copies.length = 0;
    gpu.textureWrites.length = 0;
    const base2 = page.version;
    page.dirtyRects = Array.from({ length: 40 }, (_, i) => ({ x: i * 20, y: 0, width: 10, height: 20, version: base2 + 1 + i }));
    page.version = base2 + 40;
    glyphH.beginFrame();
    hybridBackend.beginRender(dimensions);
    glyphH.render(model);
    hybridBackend.endRender();
    assert.isAbove(gpu.copies.length, 1, 'large burst should use multiple subrect copies');
    assert.ok(gpu.copies.every(c => c.size[0] < 256), 'large burst copies must be subrects, not the full page');
    assert.ok(gpu.copies.every(c => c.destination.premultipliedAlpha === true), 'subrect copies must use premultipliedAlpha');
    assert.ok(gpu.copies.every(c => c.destination.colorSpace === 'srgb'), 'subrect copies must use srgb color space');
    assert.strictEqual(gpu.textureWrites.length, 0, 'large burst must not use writeTexture');
  });

  it('lets separate contexts upload dirty rects independently', () => {
    const page = atlas.pages[0] as ITestAtlasPage;
    page.canvas = fakeCanvas();
    frame();
    const secondContext = store.add(new WebgpuContext(gpu.device, 'bgra8unorm'));
    secondContext.partialUploadThreshold = 0;
    const secondBackend = store.add(new WebgpuBackend(gpu.canvas, secondContext));
    const { glyphRenderer: glyphB } = secondBackend.createRenderers(terminal, dimensions, new MockOptionsService(), theme, new MockLogService());
    glyphB.setAtlas(atlas);
    glyphB.beginFrame();
    secondBackend.beginRender(dimensions);
    glyphB.render(model);
    secondBackend.endRender();
    gpu.copies.length = 0;
    gpu.textureWrites.length = 0;
    const base = page.version;
    page.dirtyRects = [{ x: 3, y: 4, width: 10, height: 20, version: base + 1 }];
    page.version = base + 1;
    backend.beginRender(dimensions);
    glyphRenderer.render(model);
    backend.endRender();
    assert.strictEqual(gpu.copies.length, 1);
    assert.strictEqual(gpu.textureWrites.length, 0);
    secondBackend.beginRender(dimensions);
    glyphB.render(model);
    secondBackend.endRender();
    assert.strictEqual(gpu.copies.length, 2);
    assert.strictEqual(gpu.textureWrites.length, 0);
    assert.deepStrictEqual(gpu.copies[1].sourceOrigin, [3, 4]);
    assert.deepStrictEqual(gpu.copies[1].destinationOrigin, [3, 4]);
    assert.deepStrictEqual(gpu.copies[1].size, [10, 20]);
  });

  it('invalidates atlas textures for page identity, canvas identity and dimensions', () => {
    frame();
    let previous = gpu.textures[1];
    for (const change of [
      () => atlas.pages[0] = { ...atlas.pages[0] },
      () => atlas.pages[0].canvas = { width: 64, height: 64 } as HTMLCanvasElement,
      () => atlas.pages[0].canvas.width = 128
    ]) {
      gpu.copies.length = 0;
      change();
      frame();
      assert.strictEqual(previous.destroyed, 1);
      assert.strictEqual(gpu.copies.length, 1);
      previous = gpu.textures[gpu.textures.length - 1];
      assert.strictEqual(gpu.copies[0].destination.texture, previous.texture);
    }
  });

  it('reuploads on generation resets, explicit invalidation and atlas replacement', () => {
    frame();
    for (const change of [
      () => atlas.pageLayoutVersion++,
      () => atlas.pageLayoutVersion = 0,
      () => glyphRenderer.invalidateAtlasTextures(),
      () => {
        atlas = store.add(new TestAtlas());
        glyphRenderer.setAtlas(atlas);
      }
    ]) {
      gpu.copies.length = 0;
      change();
      glyphRenderer.beginFrame();
      frame();
      assert.strictEqual(gpu.copies.length, 2);
    }
  });

  it('unbinds removed and zero-sized atlas pages', () => {
    frame();
    const first = gpu.textures[1];
    const second = gpu.textures[2];
    atlas.pages.pop();
    atlas.pages[0].canvas.width = 0;
    gpu.copies.length = 0;
    frame();
    assert.strictEqual(first.destroyed, 1);
    assert.strictEqual(second.destroyed, 1);
    assert.strictEqual(gpu.copies.length, 0);
    const entries = Array.from(gpu.bindGroups[gpu.bindGroups.length - 1].entries);
    assert.strictEqual(entries[2].resource, entries[3].resource);
    atlas.pages[0].canvas.width = 64;
    frame();
    assert.strictEqual(gpu.copies.length, 1);
  });

  it('skips zero-sized frames without consuming dirty rows', () => {
    frame();
    gpu.writes.length = 0;
    gpu.events.length = 0;
    const acquired = gpu.state.acquired;
    gpu.canvas.width = 0;
    update(0, 2);
    frame();
    assert.strictEqual(gpu.state.acquired, acquired);
    assert.strictEqual(gpu.events.length, 0);
    gpu.canvas.width = 40;
    frame();
    assert.deepStrictEqual(glyphWrites().map(e => [e.offset, e.byteLength]), [[2 * 4 * 44, 4 * 44]]);
  });

  it('rejects oversized buffers and textures before allocating them', () => {
    gpu.limits.maxBufferSize = 512;
    backend.beginRender(dimensions);
    assert.throws(() => glyphRenderer.render(model), RangeError, 'buffer size limit');
    backend.endRender();
    assert.strictEqual(gpu.buffers.filter(e => e.buffer.label === 'xterm glyphs').length, 0);
    gpu.limits.maxBufferSize = 1 << 20;
    atlas.pages[0].canvas.width = backend.maxTextureSize + 1;
    backend.beginRender(dimensions);
    assert.throws(() => glyphRenderer.render(model), RangeError, 'texture size limit');
    backend.endRender();
    assert.strictEqual(gpu.textures.length, 1);
    gpu.canvas.width = backend.maxTextureSize + 1;
    assert.throws(() => backend.beginRender(dimensions), RangeError, 'texture size limit');
  });

  it('abandons active frames on device loss and dispatches context loss once', async () => {
    let losses = 0;
    store.add(backend.onContextLoss(() => losses++));
    backend.beginRender(dimensions);
    gpu.lose({ reason: 'unknown', message: 'test loss' });
    await gpu.device.lost;
    backend.endRender();
    frame();
    assert.strictEqual(losses, 1);
    assert.strictEqual(gpu.state.acquired, 1);
    assert.strictEqual(gpu.events.filter(e => e === 'submit').length, 0);
  });

  it('disposes GPU resources and context exactly once without destroying the device', async () => {
    frame();
    let losses = 0;
    store.add(backend.onContextLoss(() => losses++));
    backend.beginRender(dimensions);
    backend.dispose();
    backend.dispose();
    context.dispose();
    context.dispose();
    const events = gpu.events.length;
    frame();
    gpu.lose({ reason: 'destroyed', message: 'addon disposed' });
    await gpu.device.lost;
    assert.strictEqual(losses, 0);
    assert.strictEqual(gpu.events.length, events);
    assert.strictEqual(gpu.state.unconfigured, 1);
    assert.strictEqual(gpu.state.deviceDestroyed, 0);
    assert.ok(gpu.buffers.every(e => e.destroyed === 1));
    assert.ok(gpu.textures.every(e => e.destroyed === 1));
  });

  it('cleans up constructor failures without taking ownership of the device', () => {
    const failingContext = createFakeGpu();
    failingContext.state.pipelineError = true;
    assert.throws(() => new WebgpuContext(failingContext.device, 'bgra8unorm'), 'pipeline failed');
    assert.strictEqual(failingContext.state.deviceDestroyed, 0);

    for (const failure of ['configureError'] as const) {
      const failing = createFakeGpu();
      failing.state[failure] = true;
      const contextFor = new WebgpuContext(failing.device, 'bgra8unorm');
      assert.throws(() => new WebgpuBackend(failing.canvas, contextFor), 'failed');
      assert.strictEqual(failing.state.unconfigured, 1);
      assert.strictEqual(failing.state.deviceDestroyed, 0);
      contextFor.dispose();
      assert.ok(failing.buffers.every(e => e.destroyed === 1));
    }

    const missing = createFakeGpu();
    missing.state.hasContext = false;
    const contextFor = new WebgpuContext(missing.device, 'bgra8unorm');
    assert.throws(() => new WebgpuBackend(missing.canvas, contextFor), 'canvas context');
    contextFor.dispose();
    assert.strictEqual(missing.state.deviceDestroyed, 0);
  });

  it('draws the cursor trail as a six-vertex quad in a dedicated buffer on every frame', () => {
    const positions = new Float32Array([0.1, 0.2, 0.3, 0.2, 0.3, 0.4, 0.1, 0.4]);
    const vertices = {
      positions,
      cursorRect: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      color: new Float32Array([1, 0.5, 0]),
      opacity: 0.5,
      visible: true,
      version: 0
    };
    backend.beginRender(dimensions);
    rectangleRenderer.renderCursorTrail(vertices);
    rectangleRenderer.renderCursorTrail(vertices);
    backend.endRender();
    const writes = gpu.writes.filter(e => e.buffer.label === 'xterm cursor trail');
    assert.strictEqual(writes.length, 2, 'trail uploads every frame regardless of version');
    const draws = gpu.draws.filter(e => e.buffer.label === 'xterm cursor trail');
    assert.strictEqual(draws.length, 2);
    assert.strictEqual(draws[0].vertices, 6);
    // Two triangles (0,1,2) and (0,2,3) reproduce kitty's GL_TRIANGLE_FAN fill.
    const expected = [0.1, 0.2, 0.3, 0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0.4, 0.1, 0.4];
    const submitted = draws[0].submitted!;
    assert.strictEqual(submitted.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert.closeTo(submitted[i], expected[i], 1e-5);
    }
  });

  it('generates top-left geometry, explicit-LOD page switches and premultiplied rectangles', () => {
    const shader = createGlyphShader(4);
    assert.include(shader, '1.0 - 2.0 * position.y');
    assert.include(shader, 'offset / viewport.xy + (cell + unit * size) * viewport.zw');
    assert.include(shader, '@binding(5) var page3');
    assert.notInclude(shader, 'var page4');
    assert.include(shader, 'case 3u: { return textureSampleLevel(page3, atlasSampler, input.uv, 0.0); }');
    assert.include(rectangleShader, 'clip((position + quad(vertex) * size) * viewport.zw)');
    assert.include(rectangleShader, 'vec4f(color.rgb * color.a, color.a)');
  });
});
