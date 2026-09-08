/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { Terminal } from '@xterm/xterm';
import { allowRescaling } from '../RendererUtils';
import { IRenderDimensions } from '../Types';
import { NULL_CELL_CODE } from '../../../../common/buffer/Constants';
import { IOptionsService } from '../../../../common/services/Services';
import { IRasterizedGlyph, ITextureAtlas } from './Types';

export const enum GlyphRenderModelConstants {
  INDICES_PER_CELL = 11,
  CELL_POSITION_INDICES = 2
}

// Work variables to avoid garbage collection in the per-cell update.
let $i = 0;
let $glyph: IRasterizedGlyph | undefined = undefined;
let $leftCellPadding = 0;
let $clippedPixels = 0;

export class GlyphRenderModel {
  private _atlas: ITextureAtlas | undefined;
  private _lastSeenPageLayoutVersion: number = -1;
  private _attributes = new Float32Array(0);

  constructor(
    private readonly _terminal: Terminal,
    private _dimensions: IRenderDimensions,
    private readonly _optionsService: IOptionsService
  ) {
    this.handleResize();
  }

  public get atlas(): ITextureAtlas | undefined { return this._atlas; }
  public get attributes(): Float32Array { return this._attributes; }

  public beginFrame(): boolean {
    if (!this._atlas) {
      return true;
    }
    if (this._atlas.pageLayoutVersion !== this._lastSeenPageLayoutVersion) {
      this._lastSeenPageLayoutVersion = this._atlas.pageLayoutVersion;
      return true;
    }
    return false;
  }

  public updateCell(x: number, y: number, code: number, bg: number, fg: number, ext: number, chars: string, width: number, lastBg: number): void {
    this._updateCell(this._attributes, x, y, code, bg, fg, ext, chars, width, lastBg);
  }

  private _updateCell(array: Float32Array, x: number, y: number, code: number | undefined, bg: number, fg: number, ext: number, chars: string, width: number, lastBg: number): void {
    $i = (y * this._terminal.cols + x) * GlyphRenderModelConstants.INDICES_PER_CELL;

    // Allow spaces through as they may have underline/strikethrough styles.
    if (code === NULL_CELL_CODE || code === undefined) {
      array.fill(0, $i, $i + GlyphRenderModelConstants.INDICES_PER_CELL - 1 - GlyphRenderModelConstants.CELL_POSITION_INDICES);
      return;
    }
    if (!this._atlas) {
      return;
    }

    if (chars && chars.length > 1) {
      $glyph = this._atlas.getRasterizedGlyphCombinedChar(chars, bg, fg, ext, false, this._terminal.element);
    } else {
      $glyph = this._atlas.getRasterizedGlyph(code, bg, fg, ext, false, this._terminal.element);
    }

    $leftCellPadding = Math.floor((this._dimensions.device.cell.width - this._dimensions.device.char.width) / 2);
    if (bg !== lastBg && $glyph.offset.x > $leftCellPadding) {
      $clippedPixels = $glyph.offset.x - $leftCellPadding;
      // offset, size, texture page, texture coordinates, texture size
      array[$i    ] = -($glyph.offset.x - $clippedPixels) + this._dimensions.device.char.left;
      array[$i + 1] = -$glyph.offset.y + this._dimensions.device.char.top;
      array[$i + 2] = ($glyph.size.x - $clippedPixels) / this._dimensions.device.canvas.width;
      array[$i + 3] = $glyph.size.y / this._dimensions.device.canvas.height;
      array[$i + 4] = $glyph.texturePage;
      array[$i + 5] = $glyph.texturePositionClipSpace.x + $clippedPixels / this._atlas.pages[$glyph.texturePage].canvas.width;
      array[$i + 6] = $glyph.texturePositionClipSpace.y;
      array[$i + 7] = $glyph.sizeClipSpace.x - $clippedPixels / this._atlas.pages[$glyph.texturePage].canvas.width;
      array[$i + 8] = $glyph.sizeClipSpace.y;
    } else {
      array[$i    ] = -$glyph.offset.x + this._dimensions.device.char.left;
      array[$i + 1] = -$glyph.offset.y + this._dimensions.device.char.top;
      array[$i + 2] = $glyph.size.x / this._dimensions.device.canvas.width;
      array[$i + 3] = $glyph.size.y / this._dimensions.device.canvas.height;
      array[$i + 4] = $glyph.texturePage;
      array[$i + 5] = $glyph.texturePositionClipSpace.x;
      array[$i + 6] = $glyph.texturePositionClipSpace.y;
      array[$i + 7] = $glyph.sizeClipSpace.x;
      array[$i + 8] = $glyph.sizeClipSpace.y;
    }
    // Cell position only changes on resize.
    if (this._optionsService.rawOptions.rescaleOverlappingGlyphs) {
      if (allowRescaling(code, width, $glyph.size.x, this._dimensions.device.cell.width)) {
        array[$i + 2] = (this._dimensions.device.cell.width - 1) / this._dimensions.device.canvas.width;
      }
    }
  }

  public clear(): void {
    const terminal = this._terminal;
    const newCount = terminal.cols * terminal.rows * GlyphRenderModelConstants.INDICES_PER_CELL;
    if (this._attributes.length !== newCount) {
      this._attributes = new Float32Array(newCount);
    } else {
      this._attributes.fill(0);
    }
    let i = 0;
    for (let y = 0; y < terminal.rows; y++) {
      for (let x = 0; x < terminal.cols; x++) {
        this._attributes[i + 9] = x / terminal.cols;
        this._attributes[i + 10] = y / terminal.rows;
        i += GlyphRenderModelConstants.INDICES_PER_CELL;
      }
    }
  }

  public handleResize(): void {
    this.clear();
  }

  public setAtlas(atlas: ITextureAtlas): void {
    this._atlas = atlas;
    this._lastSeenPageLayoutVersion = -1;
  }

  public setDimensions(dimensions: IRenderDimensions): void {
    this._dimensions = dimensions;
  }
}
