/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { Terminal } from 'browser/public/Terminal';
import { MockThemeService } from 'browser/TestUtils.test';
import { RenderModel } from 'browser/renderer/shared/gpu/RenderModel';
import type { IGlyphRenderer, IRectangleRenderer, IRasterizedGlyph, ITextureAtlas } from 'browser/renderer/shared/gpu/Types';
import type { IRenderDimensions } from 'browser/renderer/shared/Types';
import { css } from 'common/Color';
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
  submitted?: Float32Array;
}

function createFakeGpu() {
  let lose!: (info: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>(resolve => lose = resolve);
  const buffers: IBufferRecord[] = [];
  const textures: ITextureRecord[] = [];
  const writes: { buffer: GPUBuffer, offset: number, byteLength: number, data: Float32Array }[] = [];
  const copies: { source: Parameters<GPUQueue['copyExternalImageToTexture']>[0], destination: Parameters<GPUQueue['copyExternalImageToTexture']>[1] }[] = [];
  const draws: IDrawRecord[] = [];
  const pipelines: GPURenderPipelineDescriptor[] = [];
  const bindGroups: GPUBindGroupDescriptor[] = [];
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
    createSampler: () => ({}) as GPUSampler,
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
        setVertexBuffer: (_slot: number, value: GPUBuffer, offset: number, size: number) => {
          assert.strictEqual(offset, 0);
          assert.isAtMost(size, value.size);
          buffer = value;
          byteLength = size;
        },
        draw: (vertices: number, instances: number) => {
          const draw = { pipeline: pipeline.label, buffer, byteLength, vertices, instances };
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
        finish: () => ({ frameDraws })
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
      copyExternalImageToTexture: (source: Parameters<GPUQueue['copyExternalImageToTexture']>[0], destination: Parameters<GPUQueue['copyExternalImageToTexture']>[1]) => {
        copies.push({ source, destination });
        events.push('copy');
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
  return { device: device as unknown as GPUDevice, canvas, state, limits, buffers, textures, writes, copies, draws, pipelines, bindGroups, events, lose };
}

class TestAtlas extends Disposable implements ITextureAtlas {
  public readonly pages = [
    { canvas: { width: 64, height: 64 } as HTMLCanvasElement, version: 1 },
    { canvas: { width: 64, height: 64 } as HTMLCanvasElement, version: 1 }
  ];
  public pageLayoutVersion = 0;
  public readonly onAddTextureAtlasCanvas = this._register(new Emitter<HTMLCanvasElement>()).event;
  public readonly onRemoveTextureAtlasCanvas = this._register(new Emitter<HTMLCanvasElement>()).event;
  public warmUp(): void {}
  public clearTexture(): void {}
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
    backend = store.add(new WebgpuBackend(gpu.canvas, context));
    terminal = store.add(new Terminal({ cols: 4, rows: 4 }));
    dimensions = {
      css: { canvas: { width: 40, height: 80 }, cell: { width: 10, height: 20 } },
      device: { canvas: { width: 40, height: 80 }, cell: { width: 10, height: 20 }, char: { width: 10, height: 20, left: 0, top: 0 } }
    };
    const theme = new MockThemeService();
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
    backend.beginRender();
    rectangleRenderer.renderBackgrounds();
    glyphRenderer.render(model);
    rectangleRenderer.renderCursor();
    backend.endRender();
  }

  function update(x: number, y: number, code = 65): void {
    glyphRenderer.updateCell(x, y, code, 0, 0, 0, String.fromCharCode(code), 1, 0);
  }

  function glyphWrites() {
    return gpu.writes.filter(e => e.buffer.label === 'xterm glyphs');
  }

  it('configures premultiplied alpha and caps separately bound atlas textures', () => {
    assert.strictEqual(gpu.state.configuration?.alphaMode, 'premultiplied');
    assert.strictEqual(backend.maxAtlasPages, 16);
    assert.strictEqual(backend.maxTextureSize, 8192);
    for (const pipeline of gpu.pipelines) {
      assert.strictEqual(pipeline.primitive?.topology, 'triangle-strip');
      assert.deepStrictEqual(Array.from(pipeline.fragment!.targets)[0]?.blend, {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
      });
    }
    frame();
    assert.strictEqual(Array.from(gpu.bindGroups[0].entries).length, 18);
    for (const copy of gpu.copies) {
      assert.strictEqual(copy.source.flipY, false);
      assert.strictEqual(copy.destination.premultipliedAlpha, true);
      assert.strictEqual(copy.destination.colorSpace, 'srgb');
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
    backend.beginRender();
    glyphRenderer.render(model);
    backend.endRender();
    const copiesAfterFirst = gpu.copies.length;
    const texturesAfterFirst = gpu.textures.length;
    const bindGroupsAfterFirst = gpu.bindGroups.length;
    second.beginRender();
    glyphB.render(model);
    second.endRender();
    assert.strictEqual(gpu.copies.length, copiesAfterFirst);
    assert.strictEqual(gpu.textures.length, texturesAfterFirst);
    assert.strictEqual(gpu.bindGroups.length, bindGroupsAfterFirst + 1);
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
    assert.strictEqual(draw.instances, terminal.cols * terminal.rows);
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
    assert.strictEqual(gpu.draws.find(e => e.buffer.label === 'xterm glyphs')!.instances, 16);
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
    backend.beginRender();
    assert.throws(() => glyphRenderer.render(model), RangeError, 'buffer size limit');
    backend.endRender();
    assert.strictEqual(gpu.buffers.filter(e => e.buffer.label === 'xterm glyphs').length, 0);
    gpu.limits.maxBufferSize = 1 << 20;
    atlas.pages[0].canvas.width = backend.maxTextureSize + 1;
    backend.beginRender();
    assert.throws(() => glyphRenderer.render(model), RangeError, 'texture size limit');
    backend.endRender();
    assert.strictEqual(gpu.textures.length, 1);
    gpu.canvas.width = backend.maxTextureSize + 1;
    assert.throws(() => backend.beginRender(), RangeError, 'texture size limit');
  });

  it('abandons active frames on device loss and dispatches context loss once', async () => {
    let losses = 0;
    store.add(backend.onContextLoss(() => losses++));
    backend.beginRender();
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
    backend.beginRender();
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

  it('generates top-left geometry, explicit-LOD page switches and premultiplied rectangles', () => {
    const shader = createGlyphShader(4);
    assert.include(shader, '1.0 - 2.0 * position.y');
    assert.include(shader, 'offset / resolution + cell + unit * size');
    assert.include(shader, '@binding(5) var page3');
    assert.notInclude(shader, 'var page4');
    assert.include(shader, 'case 3u: { return textureSampleLevel(page3, atlasSampler, input.uv, 0.0); }');
    assert.include(rectangleShader, 'vec4f(color.rgb * color.a, color.a)');
  });
});
