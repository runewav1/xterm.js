/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { Terminal } from '../../../public/Terminal';
import { MockThemeService } from '../../../TestUtils.test';
import { DisposableStore } from '../../../../common/Lifecycle';
import { css } from '../../../../common/Color';
import { Attributes, FgFlags } from '../../../../common/buffer/Constants';
import type { IRenderDimensions } from '../Types';
import { RenderModel, RenderModelConstants } from './RenderModel';
import { RectangleRenderModel } from './RectangleRenderModel';

const CELL_WIDTH = 10;
const CELL_HEIGHT = 20;

function createDimensions(cols: number, rows: number): IRenderDimensions {
  return {
    css: { canvas: { width: cols * CELL_WIDTH, height: rows * CELL_HEIGHT }, cell: { width: CELL_WIDTH, height: CELL_HEIGHT } },
    device: { canvas: { width: cols * CELL_WIDTH, height: rows * CELL_HEIGHT }, cell: { width: CELL_WIDTH, height: CELL_HEIGHT }, char: { width: CELL_WIDTH, height: CELL_HEIGHT, left: 0, top: 0 } }
  };
}

describe('RectangleRenderModel', () => {
  let store: DisposableStore;
  let terminal: Terminal;
  let model: RenderModel;
  let renderModel: RectangleRenderModel;
  let theme: MockThemeService;

  beforeEach(() => {
    store = new DisposableStore();
    terminal = store.add(new Terminal({ cols: 2, rows: 2 }));
    theme = new MockThemeService();
    theme.colors = { ...theme.colors, cursor: css.toColor('#ffffff') };
    renderModel = store.add(new RectangleRenderModel(terminal, createDimensions(2, 2), theme));
    model = new RenderModel();
    model.resize(terminal.cols, terminal.rows);
    renderModel.handleResize();
  });

  afterEach(() => store.dispose());

  it('keeps the full-viewport clear rectangle when rebuilt from an empty model', () => {
    renderModel.updateBackgrounds(model, 0, terminal.rows - 1);
    const backgrounds = renderModel.backgrounds;
    assert.strictEqual(backgrounds.count, 1);
    // Rectangle 0 spans the whole device canvas.
    assert.deepStrictEqual(Array.from(backgrounds.attributes.slice(0, 4)), [0, 0, 1, 1]);
    // And is painted with the theme background color.
    const bg = theme.colors.background.rgba;
    assert.deepStrictEqual(Array.from(backgrounds.attributes.slice(4, 8)), Array.from(new Float32Array([
      ((bg >> 24) & 0xFF) / 255,
      ((bg >> 16) & 0xFF) / 255,
      ((bg >> 8) & 0xFF) / 255,
      1
    ])));
  });

  it('emits a rectangle for a cell with a background color', () => {
    model.cells[RenderModelConstants.BG_OFFSET] = Attributes.CM_RGB | 0xFF0000;
    renderModel.updateBackgrounds(model, 0, 0);
    const backgrounds = renderModel.backgrounds;
    assert.strictEqual(backgrounds.count, 2);
    assert.deepStrictEqual(Array.from(backgrounds.attributes.slice(8, 12)), [0, 0, 0.5, 0.5]);
    assert.deepStrictEqual(Array.from(backgrounds.attributes.slice(12, 16)), [1, 0, 0, 1]);
  });

  it('rebuilds all-default backgrounds after previously emitting rectangles', () => {
    model.cells[RenderModelConstants.BG_OFFSET] = Attributes.CM_RGB | 0xFF0000;
    renderModel.updateBackgrounds(model, 0, terminal.rows - 1);
    assert.strictEqual(renderModel.backgrounds.count, 2);
    // Clear the model entirely (as _clearModel does) and rebuild.
    model.clear();
    renderModel.updateBackgrounds(model, 0, terminal.rows - 1);
    assert.strictEqual(renderModel.backgrounds.count, 1);
  });

  it('uses the foreground color for an inverse foreground rectangle', () => {
    model.cells[RenderModelConstants.FG_OFFSET] = Attributes.CM_DEFAULT | FgFlags.INVERSE;
    renderModel.updateBackgrounds(model, 0, 0);
    const backgrounds = renderModel.backgrounds;
    assert.strictEqual(backgrounds.count, 2);
    const fg = theme.colors.foreground.rgba;
    assert.deepStrictEqual(Array.from(backgrounds.attributes.slice(12, 16)), Array.from(new Float32Array([
      ((fg >> 24) & 0xFF) / 255,
      ((fg >> 16) & 0xFF) / 255,
      ((fg >> 8) & 0xFF) / 255,
      1
    ])));
  });

  it('rebuilds row caches after a resize that changes the row count', () => {
    terminal.resize(2, 4);
    model.resize(2, 4);
    renderModel.setDimensions(createDimensions(2, 4));
    renderModel.handleResize();
    model.cells[1 * 2 * RenderModelConstants.INDICIES_PER_CELL + RenderModelConstants.BG_OFFSET] = Attributes.CM_RGB | 0x0000FF;
    renderModel.updateBackgrounds(model, 0, 3);
    assert.strictEqual(renderModel.backgrounds.count, 2);
  });

  it('bumps the background version on rebuild and resize', () => {
    const v0 = renderModel.backgrounds.version;
    renderModel.updateBackgrounds(model, 0, 1);
    assert.ok(renderModel.backgrounds.version > v0);
    const v1 = renderModel.backgrounds.version;
    renderModel.handleResize();
    assert.ok(renderModel.backgrounds.version > v1);
  });

  describe('cursor', () => {
    it('renders a single bar rectangle', () => {
      model.cursor = { x: 0, y: 0, width: 1, style: 'bar', cursorWidth: 2, dpr: 1 };
      renderModel.updateCursor(model);
      assert.strictEqual(renderModel.cursor.count, 1);
    });

    it('renders four rectangles for an outline cursor', () => {
      model.cursor = { x: 0, y: 0, width: 1, style: 'outline', cursorWidth: 2, dpr: 1 };
      renderModel.updateCursor(model);
      assert.strictEqual(renderModel.cursor.count, 4);
    });

    it('renders nothing for a block cursor', () => {
      model.cursor = { x: 0, y: 0, width: 1, style: 'block', cursorWidth: 2, dpr: 1 };
      renderModel.updateCursor(model);
      assert.strictEqual(renderModel.cursor.count, 0);
    });

    it('renders nothing when the cursor model is absent', () => {
      model.cursor = undefined;
      renderModel.updateCursor(model);
      assert.strictEqual(renderModel.cursor.count, 0);
    });
  });
});
