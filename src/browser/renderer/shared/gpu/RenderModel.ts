/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { ICursorRenderModel, IRenderModel } from './Types';
import { ISelectionRenderModel } from '../Types';
import { createSelectionRenderModel } from '../SelectionRenderModel';

export const enum RenderModelConstants {
  INDICIES_PER_CELL = 4,
  BG_OFFSET = 1,
  FG_OFFSET = 2,
  EXT_OFFSET = 3
}

export const COMBINED_CHAR_BIT_MASK = 0x80000000;

export class RenderModel implements IRenderModel {
  public cells: Uint32Array;
  public lineLengths: Uint32Array;
  public selection: ISelectionRenderModel;
  public cursor?: ICursorRenderModel;

  constructor() {
    this.cells = new Uint32Array(0);
    this.lineLengths = new Uint32Array(0);
    this.selection = createSelectionRenderModel();
  }

  public resize(cols: number, rows: number): void {
    const indexCount = cols * rows * RenderModelConstants.INDICIES_PER_CELL;
    if (indexCount !== this.cells.length) {
      this.cells = new Uint32Array(indexCount);
    }
    // Resize the row array independently of the cell array. Different col/row
    // combinations can produce the same cell count (e.g. 80x24 and 40x48) but
    // the number of rows still differs, so lineLengths must be rebuilt.
    if (rows !== this.lineLengths.length) {
      this.lineLengths = new Uint32Array(rows);
    }
  }

  public clear(): void {
    this.cells.fill(0, 0);
    this.lineLengths.fill(0, 0);
  }
}
