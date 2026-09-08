/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IRenderDimensions } from '../../Types';
import { ICoreBrowserService, IThemeService } from '../../../../services/Services';
import { Disposable, toDisposable } from '../../../../../common/Lifecycle';
import { Terminal } from '@xterm/xterm';
import { IRenderLayer } from './Types';
import { throwIfFalsy } from '../../RendererUtils';

export abstract class BaseRenderLayer extends Disposable implements IRenderLayer {
  private readonly _canvas: HTMLCanvasElement;
  protected readonly _ctx: CanvasRenderingContext2D;
  private _deviceCellWidth: number = 0;
  private _deviceCellHeight: number = 0;

  constructor(
    terminal: Terminal,
    container: HTMLElement,
    id: string,
    zIndex: number,
    protected readonly _coreBrowserService: ICoreBrowserService,
    protected readonly _themeService: IThemeService
  ) {
    super();
    this._canvas = this._coreBrowserService.mainDocument.createElement('canvas');
    this._canvas.classList.add(`xterm-${id}-layer`);
    this._canvas.style.zIndex = zIndex.toString();
    this._ctx = throwIfFalsy(this._canvas.getContext('2d', { alpha: true }));
    container.appendChild(this._canvas);
    this._register(this._themeService.onChangeColors(() => {
      this.reset(terminal);
    }));
    this._register(toDisposable(() => {
      this._canvas.remove();
    }));
  }

  public handleBlur(terminal: Terminal): void {}
  public handleFocus(terminal: Terminal): void {}
  public handleCursorMove(terminal: Terminal): void {}
  public handleGridChanged(terminal: Terminal, startRow: number, endRow: number): void {}
  public handleSelectionChanged(terminal: Terminal, start: [number, number] | undefined, end: [number, number] | undefined, columnSelectMode: boolean = false): void {}

  public resize(terminal: Terminal, dim: IRenderDimensions): void {
    this._deviceCellWidth = dim.device.cell.width;
    this._deviceCellHeight = dim.device.cell.height;
    this._canvas.width = dim.device.canvas.width;
    this._canvas.height = dim.device.canvas.height;
    this._canvas.style.width = `${dim.css.canvas.width}px`;
    this._canvas.style.height = `${dim.css.canvas.height}px`;
  }

  public abstract reset(terminal: Terminal): void;

  /**
   * Fills a 1px line (2px on HDPI) at the bottom of the cell. This uses the
   * existing fillStyle on the context.
   * @param x The column to fill.
   * @param y The row to fill.
   */
  protected _fillBottomLineAtCells(x: number, y: number, width: number = 1): void {
    this._ctx.fillRect(
      x * this._deviceCellWidth,
      (y + 1) * this._deviceCellHeight - this._coreBrowserService.dpr - 1 /* Ensure it's drawn within the cell */,
      width * this._deviceCellWidth,
      this._coreBrowserService.dpr);
  }

  /**
   * Clears 1+ cells completely.
   * @param x The column to start at.
   * @param y The row to start at.
   * @param width The number of columns to clear.
   * @param height The number of rows to clear.
   */
  protected _clearCells(x: number, y: number, width: number, height: number): void {
    this._ctx.clearRect(
      x * this._deviceCellWidth,
      y * this._deviceCellHeight,
      width * this._deviceCellWidth,
      height * this._deviceCellHeight);
  }
}

