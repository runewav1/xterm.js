/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { FontWeight, Terminal } from '@xterm/xterm';
import { IColorSet } from '../../../Types';
import { IRenderDimensions, ISelectionRenderModel } from '../Types';
import { IThemeService } from '../../../services/Services';
import { ILogService, IOptionsService } from '../../../../common/services/Services';
import { CursorInactiveStyle, CursorStyle, type IDisposable } from '../../../../common/Types';
import type { IEvent } from '../../../../common/Event';

export interface IRenderModel {
  cells: Uint32Array;
  lineLengths: Uint32Array;
  selection: ISelectionRenderModel;
  cursor?: ICursorRenderModel;
}

export interface ICursorRenderModel {
  x: number;
  y: number;
  width: number;
  style: CursorStyle | CursorInactiveStyle;
  cursorWidth: number;
  dpr: number;
}

export interface IGpuBackend extends IDisposable {
  readonly maxTextureSize: number;
  readonly maxAtlasPages: number;
  readonly onContextLoss: IEvent<void>;
  readonly onContextRestored?: IEvent<void>;
  createRenderers(terminal: Terminal, dimensions: IRenderDimensions, optionsService: IOptionsService, themeService: IThemeService, logService: ILogService): { glyphRenderer: IGlyphRenderer, rectangleRenderer: IRectangleRenderer };
  beginRender(dimensions: IRenderDimensions): void;
  endRender(): void;
}

export interface IGlyphRenderer extends IDisposable {
  beginFrame(): boolean;
  updateCell(x: number, y: number, code: number, bg: number, fg: number, ext: number, chars: string, width: number, lastBg: number): void;
  clear(): void;
  handleResize(): void;
  render(renderModel: IRenderModel): void;
  setAtlas(atlas: ITextureAtlas): void;
  invalidateAtlasTextures(): void;
  setDimensions(dimensions: IRenderDimensions): void;
}

export interface IRectangleRenderer extends IDisposable {
  renderBackgrounds(): void;
  renderCursor(): void;
  handleResize(): void;
  setDimensions(dimensions: IRenderDimensions): void;
  updateBackgrounds(model: IRenderModel, startRow: number, endRow: number): void;
  updateCursor(model: IRenderModel): void;
}

export interface ICharAtlasConfig {
  customGlyphs: boolean;
  devicePixelRatio: number;
  maxTextureSize: number;
  maxAtlasPages: number;
  letterSpacing: number;
  lineHeight: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: FontWeight;
  fontWeightBold: FontWeight;
  deviceCellWidth: number;
  deviceCellHeight: number;
  deviceCharWidth: number;
  deviceCharHeight: number;
  allowTransparency: boolean;
  drawBoldTextInBrightColors: boolean;
  minimumContrastRatio: number;
  colors: IColorSet;
}

export interface IDirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ITextureAtlas extends IDisposable {
  readonly pages: { canvas: HTMLCanvasElement, version: number }[];

  onAddTextureAtlasCanvas: IEvent<HTMLCanvasElement>;
  onRemoveTextureAtlasCanvas: IEvent<HTMLCanvasElement>;

  /**
   * Returns the dirty rectangles drawn onto `pageIndex` whose recorded page
   * version is greater than `lastVersion`, so a consumer can upload only the
   * changed regions into its GPU texture. This is non-destructive: rects stay
   * available for every consumer, and each consumer tracks its own
   * `lastVersion` to consume them exactly once. Returns an empty array when
   * the page index is invalid or there are no newer rects.
   */
  getDirtyRects(pageIndex: number, lastVersion: number): ReadonlyArray<IDirtyRect>;

  /**
   * Warm up the texture atlas, adding common glyphs to avoid slowing early frame.
   */
  warmUp(): void;

  /**
   * Incremented whenever cached glyph texture page mappings may be stale, such as after atlas page
   * merges or overflow page creation. Renderers compare this against their own last-seen value and
   * rebuild their model when it changes; a shared atlas can have many renderers, so this must not
   * be a consume-once flag.
   */
  readonly pageLayoutVersion: number;

  /**
   * Clear all glyphs from the texture atlas.
   */
  clearTexture(): void;
  getRasterizedGlyph(code: number, bg: number, fg: number, ext: number, restrictToCellHeight: boolean, domContainer: HTMLElement | undefined): IRasterizedGlyph;
  getRasterizedGlyphCombinedChar(chars: string, bg: number, fg: number, ext: number, restrictToCellHeight: boolean, domContainer: HTMLElement | undefined): IRasterizedGlyph;
}

/**
 * Represents a rasterized glyph within a texture atlas. Some numbers are
 * tracked in CSS pixels as well in order to reduce calculations during the
 * render loop.
 */
export interface IRasterizedGlyph {
  /**
   * The x and y offset between the glyph's top/left and the top/left of a cell
   * in pixels.
   */
  offset: IVector;
  /**
   * The index of the texture page that the glyph is on.
   */
  texturePage: number;
  /**
   * the x and y position of the glyph in the texture in pixels.
   */
  texturePosition: IVector;
  /**
   * the x and y position of the glyph in the texture in clip space coordinates.
   */
  texturePositionClipSpace: IVector;
  /**
   * The width and height of the glyph in the texture in pixels.
   */
  size: IVector;
  /**
   * The width and height of the glyph in the texture in clip space coordinates.
   */
  sizeClipSpace: IVector;
}

export interface IVector {
  x: number;
  y: number;
}

export interface IBoundingBox {
  top: number;
  left: number;
  right: number;
  bottom: number;
}
