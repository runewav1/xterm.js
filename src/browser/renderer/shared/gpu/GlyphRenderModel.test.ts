/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import type { Terminal } from '@xterm/xterm';
import { MockOptionsService } from '../../../../common/TestUtils.test';
import { createRenderDimensions } from '../RendererUtils';
import { GlyphRenderModel, GlyphRenderModelConstants } from './GlyphRenderModel';

const COLS = 3;
const ROWS = 4;
const STRIDE = GlyphRenderModelConstants.INDICES_PER_CELL;

describe('GlyphRenderModel', () => {
  let model: GlyphRenderModel;

  beforeEach(() => {
    const terminal = { cols: COLS, rows: ROWS } as Terminal;
    model = new GlyphRenderModel(terminal, createRenderDimensions(), new MockOptionsService());
  });

  function fillRowGlyphs(y: number, value: number): void {
    for (let x = 0; x < COLS; x++) {
      const i = (y * COLS + x) * STRIDE;
      for (let k = 0; k < STRIDE - 2; k++) {
        model.attributes[i + k] = value + k;
      }
    }
  }

  function positions(): number[] {
    const result: number[] = [];
    for (let i = 0; i < COLS * ROWS; i++) {
      result.push(model.attributes[i * STRIDE + 9], model.attributes[i * STRIDE + 10]);
    }
    return result;
  }

  it('copies glyph fields between overlapping rows while keeping cell positions', () => {
    const expectedPositions = positions();
    for (let y = 0; y < ROWS; y++) {
      fillRowGlyphs(y, (y + 1) * 100);
    }

    model.copyRows(1, 0, 3);

    assert.deepStrictEqual(positions(), expectedPositions);
    for (let y = 0; y < 3; y++) {
      assert.strictEqual(model.attributes[y * COLS * STRIDE], (y + 2) * 100, `row ${y}`);
    }
    assert.strictEqual(model.attributes[3 * COLS * STRIDE], 400);

    model.copyRows(0, 1, 3);

    assert.deepStrictEqual(positions(), expectedPositions);
    assert.strictEqual(model.attributes[1 * COLS * STRIDE], 200);
    assert.strictEqual(model.attributes[2 * COLS * STRIDE], 300);
    assert.strictEqual(model.attributes[3 * COLS * STRIDE], 400);
  });
});
