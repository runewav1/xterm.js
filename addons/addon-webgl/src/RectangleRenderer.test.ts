/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { Terminal } from 'browser/public/Terminal';
import { MockThemeService } from 'browser/TestUtils.test';
import { MockLogService } from 'common/TestUtils.test';
import { DisposableStore } from 'common/Lifecycle';
import { css } from 'common/Color';
import { Attributes } from 'common/buffer/Constants';
import type { IRenderDimensions } from 'browser/renderer/shared/Types';
import { RenderModel, RenderModelConstants } from 'browser/renderer/shared/gpu/RenderModel';
import { RectangleRenderer } from './RectangleRenderer';
import type { IWebGL2RenderingContext } from './Types';

const CELL_WIDTH = 10;
const CELL_HEIGHT = 20;

function createDimensions(cols: number, rows: number): IRenderDimensions {
  return {
    css: { canvas: { width: cols * CELL_WIDTH, height: rows * CELL_HEIGHT }, cell: { width: CELL_WIDTH, height: CELL_HEIGHT } },
    device: { canvas: { width: cols * CELL_WIDTH, height: rows * CELL_HEIGHT }, cell: { width: CELL_WIDTH, height: CELL_HEIGHT }, char: { width: CELL_WIDTH, height: CELL_HEIGHT, left: 0, top: 0 } }
  };
}

interface IBufferDataRecord {
  data: ArrayBufferView;
  usage: number;
}

interface IDrawRecord {
  count: number;
  instanceCount: number;
}

function createFakeGl(): { gl: IWebGL2RenderingContext, bufferDatas: IBufferDataRecord[], drawInstances: IDrawRecord[] } {
  const bufferDatas: IBufferDataRecord[] = [];
  const drawInstances: IDrawRecord[] = [];
  const gl = {
    VERTEX_SHADER: 0x8B31,
    FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FLOAT: 0x1406,
    STATIC_DRAW: 0x88E4,
    DYNAMIC_DRAW: 0x88E8,
    TRIANGLE_STRIP: 0x5,
    UNSIGNED_BYTE: 0x1401,
    BLEND: 0x0BE2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    enable: () => {},
    blendFunc: () => {},
    createProgram: () => ({}),
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    deleteShader: () => {},
    deleteProgram: () => {},
    deleteBuffer: () => {},
    getUniformLocation: () => ({}),
    createVertexArray: () => ({}),
    deleteVertexArray: () => {},
    bindVertexArray: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: (_target: number, data: ArrayBufferView, usage: number) => {
      bufferDatas.push({ data, usage });
    },
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},
    useProgram: () => {},
    uniformMatrix4fv: () => {},
    drawElementsInstanced: (_mode: number, count: number, _type: number, _offset: number, instanceCount: number) => {
      drawInstances.push({ count, instanceCount });
    }
  } as unknown as IWebGL2RenderingContext;
  return { gl, bufferDatas, drawInstances };
}

describe('RectangleRenderer', () => {
  let store: DisposableStore;
  let glEnv: ReturnType<typeof createFakeGl>;
  let renderer: RectangleRenderer;
  let model: RenderModel;

  beforeEach(() => {
    store = new DisposableStore();
    glEnv = createFakeGl();
    const terminal = store.add(new Terminal({ cols: 2, rows: 2 }));
    const theme = new MockThemeService();
    theme.colors = { ...theme.colors, cursor: css.toColor('#ffffff') };
    renderer = store.add(new RectangleRenderer(terminal, glEnv.gl, createDimensions(2, 2), theme, new MockLogService()));
    model = new RenderModel();
    model.resize(terminal.cols, terminal.rows);
  });

  afterEach(() => store.dispose());

  it('skips rendering and uploading when there are no rectangles', () => {
    // The constructor uploads the unit quad and element indices buffers only.
    renderer.renderBackgrounds();
    assert.strictEqual(glEnv.bufferDatas.length, 2);
    assert.strictEqual(glEnv.drawInstances.length, 0);
  });

  it('uploads only the used floats instead of the backing capacity', () => {
    model.cells[RenderModelConstants.BG_OFFSET] = Attributes.CM_RGB | 0xFF0000;
    renderer.updateBackgrounds(model, 0, 0);
    renderer.renderBackgrounds();
    // 2 rectangles: the viewport-clear rectangle plus one cell background.
    const upload = glEnv.bufferDatas[glEnv.bufferDatas.length - 1];
    assert.ok(upload.data instanceof Float32Array);
    assert.strictEqual(upload.data.byteLength, 2 * 8 * Float32Array.BYTES_PER_ELEMENT);
    assert.strictEqual(glEnv.drawInstances.length, 1);
    assert.strictEqual(glEnv.drawInstances[0].instanceCount, 2);
  });

  it('uploads a single rectangle when rendering a bar cursor', () => {
    model.cursor = { x: 0, y: 0, width: 1, style: 'bar', cursorWidth: 2, dpr: 1 };
    renderer.updateCursor(model);
    renderer.renderCursor();
    const upload = glEnv.bufferDatas[glEnv.bufferDatas.length - 1];
    assert.ok(upload.data instanceof Float32Array);
    assert.strictEqual(upload.data.byteLength, 8 * Float32Array.BYTES_PER_ELEMENT);
    assert.strictEqual(glEnv.drawInstances.length, 1);
    assert.strictEqual(glEnv.drawInstances[0].instanceCount, 1);
  });

  it('skips cursor rendering when no cursor is present', () => {
    renderer.updateCursor(model);
    renderer.renderCursor();
    assert.strictEqual(glEnv.drawInstances.length, 0);
  });

  it('draws smear vertices and enables alpha blending', () => {
    const calls: string[] = [];
    (glEnv.gl as any).enable = () => calls.push('enable');
    (glEnv.gl as any).blendFunc = () => calls.push('blendFunc');
    const attributes = new Float32Array(8);
    renderer.renderCursorSmear({ attributes, count: 1, version: 0 });
    assert.deepEqual(calls, ['enable', 'blendFunc']);
    assert.strictEqual(glEnv.drawInstances.length, 1);
    assert.strictEqual(glEnv.drawInstances[0].instanceCount, 1);
    assert.strictEqual((glEnv.bufferDatas[glEnv.bufferDatas.length - 1].data as Float32Array).byteLength, 8 * Float32Array.BYTES_PER_ELEMENT);
  });

  it('skips smear rendering when there are no vertices', () => {
    renderer.renderCursorSmear({ attributes: new Float32Array(0), count: 0, version: 0 });
    assert.strictEqual(glEnv.drawInstances.length, 0);
  });
});