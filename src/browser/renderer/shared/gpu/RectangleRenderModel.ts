/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IRenderDimensions } from '../Types';
import { IThemeService } from '../../../services/Services';
import { ReadonlyColorSet } from '../../../Types';
import { Attributes, FgFlags } from '../../../../common/buffer/Constants';
import { Disposable } from '../../../../common/Lifecycle';
import { IColor } from '../../../../common/Types';
import { Terminal } from '@xterm/xterm';
import { RenderModelConstants } from './RenderModel';
import { IRenderModel } from './Types';
import { expandFloat32Array } from './TypedArray';

const INDICES_PER_RECTANGLE = 8;

const INITIAL_BUFFER_RECTANGLE_CAPACITY = 20 * INDICES_PER_RECTANGLE;

class Vertices {
  public attributes: Float32Array;
  public count: number;

  constructor(capacity: number = INITIAL_BUFFER_RECTANGLE_CAPACITY) {
    this.attributes = new Float32Array(capacity);
    this.count = 0;
  }
}

// Work variables to avoid garbage collection
let $rgba = 0;
let $x1 = 0;
let $y1 = 0;
let $r = 0;
let $g = 0;
let $b = 0;
let $a = 0;

export class RectangleRenderModel extends Disposable {
  private _bgFloat!: Float32Array;
  private _cursorFloat!: Float32Array;

  private _vertices: Vertices = new Vertices();
  private _verticesCursor: Vertices = new Vertices();
  // Per-row rectangle segments, so only dirty rows are rescanned each frame. Row
  // order is preserved when repacking so the packed array matches the previous
  // full rebuild exactly.
  private _rowRects: Vertices[] = [];
  private _rowCounts: Uint32Array = new Uint32Array(0);

  constructor(
    private _terminal: Terminal,
    private _dimensions: IRenderDimensions,
    private readonly _themeService: IThemeService
  ) {
    super();

    this._updateCachedColors(_themeService.colors);
    this._register(this._themeService.onChangeColors(e => {
      this._updateCachedColors(e);
      this._updateViewportRectangle();
    }));
  }

  public get backgrounds(): { attributes: Float32Array, count: number } { return this._vertices; }
  public get cursor(): { attributes: Float32Array, count: number } { return this._verticesCursor; }

  public handleResize(): void {
    this._updateViewportRectangle();
  }

  public setDimensions(dimensions: IRenderDimensions): void {
    this._dimensions = dimensions;
  }

  private _updateCachedColors(colors: ReadonlyColorSet): void {
    this._bgFloat = this._colorToFloat32Array(colors.background);
    this._cursorFloat = this._colorToFloat32Array(colors.cursor);
  }

  private _updateViewportRectangle(): void {
    // Set first rectangle that clears the screen
    this._addRectangleFloat(
      this._vertices.attributes,
      0,
      0,
      0,
      this._terminal.cols * this._dimensions.device.cell.width,
      this._terminal.rows * this._dimensions.device.cell.height,
      this._bgFloat
    );
  }

  public updateBackgrounds(model: IRenderModel, startRow: number, endRow: number): void {
    const terminal = this._terminal;
    if (this._rowRects.length !== terminal.rows) {
      this._rowRects = new Array(terminal.rows);
      this._rowCounts = new Uint32Array(terminal.rows);
      const capacity = terminal.cols * INDICES_PER_RECTANGLE;
      for (let y = 0; y < terminal.rows; y++) {
        this._rowRects[y] = new Vertices(capacity);
      }
    }
    startRow = Math.max(0, Math.min(startRow, terminal.rows - 1));
    endRow = Math.max(0, Math.min(endRow, terminal.rows - 1));
    for (let y = startRow; y <= endRow; y++) {
      this._updateRow(model, y);
    }

    // Repack all rows after the viewport-clear rectangle at index 0. Unchanged
    // rows are copied, not rescanned, so a sparse update no longer scans the
    // whole grid.
    const vertices = this._vertices;
    let rectIndex = 1;
    for (let y = 0; y < terminal.rows; y++) {
      const count = this._rowCounts[y];
      if (!count) {
        continue;
      }
      const offset = rectIndex * INDICES_PER_RECTANGLE;
      const needed = offset + count * INDICES_PER_RECTANGLE;
      if (vertices.attributes.length < needed) {
        // Bulk-copying a whole row segment can exceed a single doubling, so grow
        // to at least `needed` in one step, bounded by the theoretical maximum.
        const maxLength = (terminal.rows * terminal.cols + 1) * INDICES_PER_RECTANGLE;
        const grown = new Float32Array(Math.min(Math.max(vertices.attributes.length * 2, needed), maxLength));
        grown.set(vertices.attributes);
        vertices.attributes = grown;
      }
      vertices.attributes.set(this._rowRects[y].attributes.subarray(0, count * INDICES_PER_RECTANGLE), offset);
      rectIndex += count;
    }
    vertices.count = rectIndex;
  }

  private _updateRow(model: IRenderModel, y: number): void {
    const terminal = this._terminal;
    const vertices = this._rowRects[y];
    let rectangleCount = 0;
    let currentStartX = -1;
    let currentBg = 0;
    let currentFg = 0;
    let currentInverse = false;
    for (let x = 0; x < terminal.cols; x++) {
      const modelIndex = ((y * terminal.cols) + x) * RenderModelConstants.INDICIES_PER_CELL;
      const bg = model.cells[modelIndex + RenderModelConstants.BG_OFFSET];
      const fg = model.cells[modelIndex + RenderModelConstants.FG_OFFSET];
      const inverse = !!(fg & FgFlags.INVERSE);
      if (bg !== currentBg || (fg !== currentFg && (currentInverse || inverse))) {
        // A rectangle needs to be drawn if going from non-default to another color
        if (currentBg !== 0 || (currentInverse && currentFg !== 0)) {
          this._updateRectangle(vertices, rectangleCount++ * INDICES_PER_RECTANGLE, currentFg, currentBg, currentStartX, x, y);
        }
        currentStartX = x;
        currentBg = bg;
        currentFg = fg;
        currentInverse = inverse;
      }
    }
    // Finish rectangle if it's still going
    if (currentBg !== 0 || (currentInverse && currentFg !== 0)) {
      this._updateRectangle(vertices, rectangleCount++ * INDICES_PER_RECTANGLE, currentFg, currentBg, currentStartX, terminal.cols, y);
    }
    this._rowCounts[y] = rectangleCount;
  }

  public updateCursor(model: IRenderModel): void {
    const vertices = this._verticesCursor;
    const cursor = model.cursor;
    if (!cursor || cursor.style === 'block') {
      vertices.count = 0;
      return;
    }

    let offset: number;
    let rectangleCount = 0;

    if (cursor.style === 'bar' || cursor.style === 'outline') {
      // Left edge
      offset = rectangleCount++ * INDICES_PER_RECTANGLE;
      this._addRectangleFloat(
        vertices.attributes,
        offset,
        cursor.x * this._dimensions.device.cell.width,
        cursor.y * this._dimensions.device.cell.height,
        cursor.style === 'bar' ? cursor.dpr * cursor.cursorWidth : cursor.dpr,
        this._dimensions.device.cell.height,
        this._cursorFloat
      );
    }
    if (cursor.style === 'underline' || cursor.style === 'outline') {
      // Bottom edge
      offset = rectangleCount++ * INDICES_PER_RECTANGLE;
      this._addRectangleFloat(
        vertices.attributes,
        offset,
        cursor.x * this._dimensions.device.cell.width,
        (cursor.y + 1) * this._dimensions.device.cell.height - cursor.dpr,
        cursor.width * this._dimensions.device.cell.width,
        cursor.dpr,
        this._cursorFloat
      );
    }
    if (cursor.style === 'outline') {
      // Top edge
      offset = rectangleCount++ * INDICES_PER_RECTANGLE;
      this._addRectangleFloat(
        vertices.attributes,
        offset,
        cursor.x * this._dimensions.device.cell.width,
        cursor.y * this._dimensions.device.cell.height,
        cursor.width * this._dimensions.device.cell.width,
        cursor.dpr,
        this._cursorFloat
      );
      // Right edge
      offset = rectangleCount++ * INDICES_PER_RECTANGLE;
      this._addRectangleFloat(
        vertices.attributes,
        offset,
        (cursor.x + cursor.width) * this._dimensions.device.cell.width - cursor.dpr,
        cursor.y * this._dimensions.device.cell.height,
        cursor.dpr,
        this._dimensions.device.cell.height,
        this._cursorFloat
      );
    }

    vertices.count = rectangleCount;
  }

  private _updateRectangle(vertices: Vertices, offset: number, fg: number, bg: number, startX: number, endX: number, y: number): void {
    if (fg & FgFlags.INVERSE) {
      switch (fg & Attributes.CM_MASK) {
        case Attributes.CM_P16:
        case Attributes.CM_P256:
          $rgba = this._themeService.colors.ansi[fg & Attributes.PCOLOR_MASK].rgba;
          break;
        case Attributes.CM_RGB:
          $rgba = (fg & Attributes.RGB_MASK) << 8;
          break;
        case Attributes.CM_DEFAULT:
        default:
          $rgba = this._themeService.colors.foreground.rgba;
      }
    } else {
      switch (bg & Attributes.CM_MASK) {
        case Attributes.CM_P16:
        case Attributes.CM_P256:
          $rgba = this._themeService.colors.ansi[bg & Attributes.PCOLOR_MASK].rgba;
          break;
        case Attributes.CM_RGB:
          $rgba = (bg & Attributes.RGB_MASK) << 8;
          break;
        case Attributes.CM_DEFAULT:
        default:
          $rgba = this._themeService.colors.background.rgba;
      }
    }

    if (vertices.attributes.length < offset + INDICES_PER_RECTANGLE) {
      // +1 for the viewport-clear rectangle at offset 0.
      vertices.attributes = expandFloat32Array(vertices.attributes, (this._terminal.rows * this._terminal.cols + 1) * INDICES_PER_RECTANGLE);
    }
    $x1 = startX * this._dimensions.device.cell.width;
    $y1 = y * this._dimensions.device.cell.height;
    $r = (($rgba >> 24) & 0xFF) / 255;
    $g = (($rgba >> 16) & 0xFF) / 255;
    $b = (($rgba >> 8 ) & 0xFF) / 255;
    $a = 1;

    this._addRectangle(vertices.attributes, offset, $x1, $y1, (endX - startX) * this._dimensions.device.cell.width, this._dimensions.device.cell.height, $r, $g, $b, $a);
  }

  private _addRectangle(array: Float32Array, offset: number, x1: number, y1: number, width: number, height: number, r: number, g: number, b: number, a: number): void {
    array[offset    ] = x1 / this._dimensions.device.canvas.width;
    array[offset + 1] = y1 / this._dimensions.device.canvas.height;
    array[offset + 2] = width / this._dimensions.device.canvas.width;
    array[offset + 3] = height / this._dimensions.device.canvas.height;
    array[offset + 4] = r;
    array[offset + 5] = g;
    array[offset + 6] = b;
    array[offset + 7] = a;
  }

  private _addRectangleFloat(array: Float32Array, offset: number, x1: number, y1: number, width: number, height: number, color: Float32Array): void {
    array[offset    ] = x1 / this._dimensions.device.canvas.width;
    array[offset + 1] = y1 / this._dimensions.device.canvas.height;
    array[offset + 2] = width / this._dimensions.device.canvas.width;
    array[offset + 3] = height / this._dimensions.device.canvas.height;
    array[offset + 4] = color[0];
    array[offset + 5] = color[1];
    array[offset + 6] = color[2];
    array[offset + 7] = color[3];
  }

  private _colorToFloat32Array(color: IColor): Float32Array {
    return new Float32Array([
      ((color.rgba >> 24) & 0xFF) / 255,
      ((color.rgba >> 16) & 0xFF) / 255,
      ((color.rgba >> 8 ) & 0xFF) / 255,
      ((color.rgba      ) & 0xFF) / 255
    ]);
  }
}
