/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { RenderModel, RenderModelConstants } from './RenderModel';

describe('RenderModel', () => {
  describe('resize', () => {
    it('should allocate cells and line lengths for the initial size', () => {
      const model = new RenderModel();
      model.resize(80, 24);
      assert.strictEqual(model.cells.length, 80 * 24 * RenderModelConstants.INDICIES_PER_CELL);
      assert.strictEqual(model.lineLengths.length, 24);
    });

    it('should rebuild the row array when only rows change despite an unchanged cell count', () => {
      // 80x24 and 40x48 have the same cell count but different row counts, so
      // lineLengths must be resized independently of the cell array.
      const model = new RenderModel();
      model.resize(80, 24);
      const cells = model.cells;
      const lineLengths = model.lineLengths;
      lineLengths[0] = 10;
      lineLengths[23] = 5;
      model.resize(40, 48);
      assert.strictEqual(model.cells, cells, 'cells should be reused when the cell count is unchanged');
      assert.notStrictEqual(model.lineLengths, lineLengths, 'lineLengths must be rebuilt when rows change');
      assert.strictEqual(model.cells.length, 40 * 48 * RenderModelConstants.INDICIES_PER_CELL);
      assert.strictEqual(model.lineLengths.length, 48);
      assert.strictEqual(model.lineLengths[0], 0);
    });

    it('should rebuild both arrays when the cell count changes', () => {
      const model = new RenderModel();
      model.resize(80, 24);
      const cells = model.cells;
      const lineLengths = model.lineLengths;
      model.resize(80, 48);
      assert.notStrictEqual(model.cells, cells);
      assert.notStrictEqual(model.lineLengths, lineLengths);
      assert.strictEqual(model.cells.length, 80 * 48 * RenderModelConstants.INDICIES_PER_CELL);
      assert.strictEqual(model.lineLengths.length, 48);
    });

    it('should not reallocate when resizing to the same dimensions', () => {
      const model = new RenderModel();
      model.resize(80, 24);
      const cells = model.cells;
      const lineLengths = model.lineLengths;
      model.resize(80, 24);
      assert.strictEqual(model.cells, cells);
      assert.strictEqual(model.lineLengths, lineLengths);
    });
  });

  describe('clear', () => {
    it('should zero all cells and line lengths', () => {
      const model = new RenderModel();
      model.resize(2, 2);
      model.cells.fill(0xFFFFFFFF);
      model.lineLengths.fill(1);
      model.clear();
      for (let i = 0; i < model.cells.length; i++) {
        assert.strictEqual(model.cells[i], 0);
      }
      for (let i = 0; i < model.lineLengths.length; i++) {
        assert.strictEqual(model.lineLengths[i], 0);
      }
    });
  });
});
