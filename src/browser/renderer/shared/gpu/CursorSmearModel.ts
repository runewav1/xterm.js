/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IRenderDimensions } from '../Types';
import { ICoreBrowserService, IThemeService } from '../../../services/Services';
import { Disposable, toDisposable } from '../../../../common/Lifecycle';
import { CursorInactiveStyle, CursorStyle, ICursorSmearOptions } from '../../../../common/Types';
import { IResolvedCursorSmearOptions, resolveCursorSmearOptions } from '../../../../common/CursorSmear';
import { ICursorRenderModel, IRectangleVertices } from './Types';

const enum Constants {
  MAX_SAMPLES = 16,
  FLOATS_PER_RECT = 8,
  MAX_RECTS_PER_GHOST = 4,
  /** A single shape rectangle can be split into at most four when clipped. */
  MAX_CLIP_RECTS = 4,
  /** Fraction of the duration spent travelling, the rest fades the trail. */
  TRAVEL_FRACTION = 0.7
}

interface ICursorSnapshot {
  x: number;
  y: number;
  /** Width in cells (2 for wide cells). */
  width: number;
  style: CursorStyle | CursorInactiveStyle;
  cursorWidth: number;
  dpr: number;
}

// Module level work variables to avoid garbage collection in the hot path.
let $r = 0;
let $g = 0;
let $b = 0;
// Live-cursor exclusion rectangle (device pixels) for the current build.
let $exL = 0;
let $exT = 0;
let $exR = 0;
let $exB = 0;
let $hasExclusion = false;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function ease(easing: IResolvedCursorSmearOptions['easing'], t: number): number {
  switch (easing) {
    case 'linear':
      return t;
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case 'easeOut':
    default:
      return 1 - Math.pow(1 - t, 3);
  }
}

/**
 * Computes the optional cursor smear geometry. The model owns only a small,
 * preallocated vertex buffer that is rebuilt every animation frame using
 * module-level work variables, so an active animation allocates nothing. It
 * never touches the cell, background or glyph render models. While disabled,
 * hidden, idle or producing no visible effect (duration/opacity/alpha of zero)
 * it performs no work and schedules no animation frame.
 *
 * Smear geometry that overlaps the live cursor is clipped away (up to four
 * rectangles per shape) so the baked block cursor is never tinted; text and the
 * live cursor are drawn after the smear regardless.
 */
export class CursorSmearModel extends Disposable {
  private _options: IResolvedCursorSmearOptions;
  private readonly _vertices: IRectangleVertices = {
    attributes: new Float32Array((Constants.MAX_SAMPLES * Constants.MAX_RECTS_PER_GHOST * Constants.MAX_CLIP_RECTS + 4) * Constants.FLOATS_PER_RECT),
    count: 0,
    version: 0
  };
  private _source: ICursorSnapshot | undefined;
  private _head: ICursorSnapshot | undefined;
  private _startTime = 0;
  private _frame: number | undefined;
  /** Window that issued the pending frame id, so cancellation targets it after a window change. */
  private _frameWindow: (Window & typeof globalThis) | undefined;
  private _reducedMotion = false;
  private _reducedMotionQuery: MediaQueryList | undefined;
  private _themeColorRgba: number;
  private readonly _now: () => number;

  constructor(
    private _dimensions: IRenderDimensions,
    private readonly _coreBrowserService: ICoreBrowserService,
    private readonly _themeService: IThemeService,
    private readonly _requestRender: () => void,
    now?: () => number
  ) {
    super();
    this._options = resolveCursorSmearOptions(undefined);
    this._themeColorRgba = this._readThemeColor();
    this._now = now ?? (() => {
      const performance = this._coreBrowserService.window.performance;
      return performance && typeof performance.now === 'function' ? performance.now() : Date.now();
    });

    this._register(this._themeService.onChangeColors(() => {
      this._themeColorRgba = this._readThemeColor();
      this._refresh();
    }));
    this._register(this._coreBrowserService.onWindowChange(() => {
      this._cancelFrame();
      this._bindReducedMotion();
      this.reset();
    }));
    this._register(toDisposable(() => {
      this._reducedMotionQuery?.removeEventListener?.('change', this._handleReducedMotionChange);
      this._reducedMotionQuery = undefined;
      this._cancelFrame();
    }));
    this._bindReducedMotion();
  }

  public get vertices(): IRectangleVertices { return this._vertices; }

  private get _isEnabled(): boolean {
    return this._options.enabled && !(this._options.respectReducedMotion && this._reducedMotion);
  }

  /**
   * Whether the current options can produce any visible pixel. False disables
   * scheduling and geometry while still letting {@link setCursor} maintain a
   * fresh baseline for when the options become visible again.
   */
  private get _isEffectivelyAnimatable(): boolean {
    if (!this._isEnabled || this._options.duration <= 0 || this._options.opacity <= 0) {
      return false;
    }
    return ((this._options.colorRgba ?? this._themeColorRgba) & 0xFF) > 0;
  }

  private _readThemeColor(): number {
    return this._themeService.colors.cursor?.rgba ?? 0xFFFFFFFF;
  }

  private _bindReducedMotion(): void {
    this._reducedMotionQuery?.removeEventListener?.('change', this._handleReducedMotionChange);
    this._reducedMotionQuery = undefined;
    const parentWindow = this._coreBrowserService.window;
    if (typeof parentWindow.matchMedia !== 'function') {
      this._reducedMotion = false;
      return;
    }
    const query = parentWindow.matchMedia('(prefers-reduced-motion: reduce)');
    this._reducedMotionQuery = query;
    this._reducedMotion = query.matches;
    query.addEventListener?.('change', this._handleReducedMotionChange);
  }

  private _handleReducedMotionChange = (): void => {
    const matches = this._reducedMotionQuery?.matches ?? false;
    if (this._reducedMotion === matches) {
      return;
    }
    this._reducedMotion = matches;
    this._refresh();
  };

  /**
   * Applies new options. If the smear becomes invisible or disabled any active
   * trail is cleared; otherwise an in-flight trail is rebuilt immediately so
   * the rendered vertices never lag behind the options.
   */
  public setOptions(options: ICursorSmearOptions | undefined): void {
    this._options = resolveCursorSmearOptions(options);
    this._refresh();
  }

  public setDimensions(dimensions: IRenderDimensions): void {
    this._dimensions = dimensions;
    // Geometry is derived from device cell/canvas sizes, so a resize must drop
    // any in-flight trail rather than re-project it with stale pixels.
    this.reset();
  }

  /**
   * Feeds the current cursor model. `undefined` means the cursor is hidden,
   * blinking off, blurred or outside the viewport and hard clears the trail.
   */
  public setCursor(cursor: ICursorRenderModel | undefined): void {
    if (!this._isEnabled) {
      this.reset();
      return;
    }
    if (!cursor || cursor.style === 'none') {
      this.reset();
      return;
    }

    const head = this._head;
    if (head &&
        head.x === cursor.x && head.y === cursor.y && head.width === cursor.width &&
        head.style === cursor.style && head.cursorWidth === cursor.cursorWidth && head.dpr === cursor.dpr) {
      return;
    }

    const snapshot = this._snapshot(cursor);
    if (!this._isEffectivelyAnimatable) {
      // No visible effect is possible; keep a fresh baseline without geometry
      // or animation frames so enabling the effect later starts from here.
      this._settle(snapshot);
      return;
    }
    if (!head) {
      // First observation establishes a reference point without producing a
      // phantom trail.
      this._source = snapshot;
      this._head = snapshot;
      return;
    }

    const distance = Math.max(Math.abs(snapshot.x - head.x), Math.abs(snapshot.y - head.y));
    if (distance === 0 || distance < this._options.minDistance) {
      // Ignored movement (including shape-only changes) clears any in-flight
      // trail and re-baselines so stale geometry is neither drawn nor scheduled.
      this._settle(snapshot);
      return;
    }
    if (this._options.maxDistance > 0 && distance > this._options.maxDistance) {
      this._settle(snapshot);
      return;
    }

    // Continue from the currently rendered position so rapid retargets stay
    // continuous instead of teleporting the trail back to the previous cell.
    this._source = this._currentSnapshot() ?? head;
    this._head = snapshot;
    this._startTime = this._now();
    // Build the first frame synchronously so the render that observed the move
    // already includes the trail instead of showing it one frame late.
    this._build(this._progress());
    this._requestRender();
    this._ensureFrame();
  }

  /**
   * Hard clears the trail, cancels any pending frame and requests one final
   * render so the overlay is erased. Fully idempotent and cheap when idle.
   */
  public reset(): void {
    const hadTrail = this._vertices.count > 0 || this._source !== undefined || this._head !== undefined || this._frame !== undefined;
    this._cancelFrame();
    this._source = undefined;
    this._head = undefined;
    if (!hadTrail) {
      return;
    }
    this._vertices.count = 0;
    this._vertices.version++;
    this._requestRender();
  }

  /**
   * Clears any in-flight trail and moves the baseline to `snapshot`. Unlike
   * {@link reset} the cursor baseline is retained, so the next move can smear.
   */
  private _settle(snapshot: ICursorSnapshot): void {
    const hadTrail = this._vertices.count > 0 || this._frame !== undefined;
    this._cancelFrame();
    this._source = snapshot;
    this._head = snapshot;
    if (hadTrail) {
      this._vertices.count = 0;
      this._vertices.version++;
      this._requestRender();
    }
  }

  private _snapshot(cursor: ICursorRenderModel): ICursorSnapshot {
    return {
      x: cursor.x,
      y: cursor.y,
      width: cursor.width,
      style: cursor.style,
      cursorWidth: cursor.cursorWidth,
      dpr: cursor.dpr
    };
  }

  private _progress(): number {
    if (this._options.duration <= 0) {
      return 1;
    }
    return clamp((this._now() - this._startTime) / this._options.duration, 0, 1);
  }

  private _headProgress(progress: number): number {
    return ease(this._options.easing, clamp(progress / Constants.TRAVEL_FRACTION, 0, 1));
  }

  /**
   * The position the trail currently appears to be at. When idle (or after the
   * animation completed) this is the retained head baseline. In fade mode the
   * visible ghost is the source, so retargets continue from there rather than
   * from the invisible interpolated head.
   */
  private _currentSnapshot(): ICursorSnapshot | undefined {
    if (this._source === this._head) {
      return this._head;
    }
    if (!this._source || !this._head) {
      return undefined;
    }
    if (this._options.style === 'fade') {
      return this._source;
    }
    const t = this._headProgress(this._progress());
    return {
      x: lerp(this._source.x, this._head.x, t),
      y: lerp(this._source.y, this._head.y, t),
      width: lerp(this._source.width, this._head.width, t),
      style: t < 0.5 ? this._source.style : this._head.style,
      cursorWidth: this._head.cursorWidth,
      dpr: this._head.dpr
    };
  }

  private _ensureFrame(): void {
    if (this._frame !== undefined || !this._isEffectivelyAnimatable) {
      return;
    }
    const parentWindow = this._coreBrowserService.window;
    if (typeof parentWindow.requestAnimationFrame !== 'function') {
      return;
    }
    this._frameWindow = parentWindow;
    this._frame = parentWindow.requestAnimationFrame(this._tick);
  }

  private _cancelFrame(): void {
    if (this._frame === undefined) {
      return;
    }
    // Cancel on the window that scheduled the id; after a window change the
    // current service window would not own it.
    this._frameWindow?.cancelAnimationFrame?.(this._frame);
    this._frame = undefined;
    this._frameWindow = undefined;
  }

  /**
   * Rebuilds an in-flight trail after options or theme changed, or clears an
   * idle overlay that is no longer visible. Called synchronously so vertices
   * are never stale relative to the current options.
   */
  private _refresh(): void {
    if (!this._isEffectivelyAnimatable) {
      this.reset();
      return;
    }
    if (this._source && this._head && this._source !== this._head) {
      this._build(this._progress());
      this._requestRender();
      this._ensureFrame();
      return;
    }
    if (this._vertices.count > 0) {
      this._vertices.count = 0;
      this._vertices.version++;
      this._requestRender();
    }
  }

  private _tick = (): void => {
    this._frame = undefined;
    this._frameWindow = undefined;
    if (!this._isEffectivelyAnimatable || !this._source || !this._head) {
      return;
    }
    const progress = this._progress();
    if (progress >= 1) {
      // Retain the final cursor baseline so the next move smears instead of
      // being mistaken for a first observation.
      this._source = this._head;
      this._vertices.count = 0;
      this._vertices.version++;
      this._requestRender();
      return;
    }
    this._build(progress);
    this._requestRender();
    this._ensureFrame();
  };

  private _build(progress: number): void {
    const source = this._source!;
    const head = this._head!;
    this._vertices.count = 0;
    this._vertices.version++;

    if (!this._isEffectivelyAnimatable) {
      return;
    }
    const fade = 1 - progress;
    if (fade <= 0) {
      return;
    }
    const colorRgba = this._options.colorRgba ?? this._themeColorRgba;
    // Multiply the parsed/theme alpha so translucent colors fade correctly.
    const colorAlpha = (colorRgba & 0xFF) / 255;
    const baseOpacity = this._options.opacity * fade * colorAlpha;
    if (baseOpacity <= 0) {
      return;
    }

    $hasExclusion = head.style === 'block';
    if ($hasExclusion) {
      const cellW = this._dimensions.device.cell.width;
      const cellH = this._dimensions.device.cell.height;
      $exL = head.x * cellW;
      $exT = head.y * cellH;
      $exR = (head.x + head.width) * cellW;
      $exB = (head.y + 1) * cellH;
    }

    if (this._options.style === 'fade') {
      this._emitShape(
        source.x, source.y, source.width, source.style, source.cursorWidth, source.dpr,
        lerp(this._options.endScale, 1, fade), baseOpacity, colorRgba
      );
      return;
    }

    const headP = this._headProgress(progress);
    const samples = this._options.samples;
    for (let k = 0; k < samples; k++) {
      const frac = samples <= 1 ? 1 : k / (samples - 1);
      const position = headP * frac;
      this._emitShape(
        lerp(source.x, head.x, position),
        lerp(source.y, head.y, position),
        lerp(source.width, head.width, frac),
        head.style,
        head.cursorWidth,
        head.dpr,
        lerp(this._options.endScale, 1, frac),
        baseOpacity * (0.25 + 0.75 * frac),
        colorRgba
      );
    }
  }

  /** Emits one cursor shape scaled about its own center. Allocation free. */
  private _emitShape(
    x: number,
    y: number,
    width: number,
    style: CursorStyle | CursorInactiveStyle,
    cursorWidth: number,
    dpr: number,
    scale: number,
    alpha: number,
    colorRgba: number
  ): void {
    if (alpha <= 0 || scale <= 0) {
      return;
    }

    const cellW = this._dimensions.device.cell.width;
    const cellH = this._dimensions.device.cell.height;
    if (cellW <= 0 || cellH <= 0) {
      return;
    }
    const centerX = x * cellW + width * cellW / 2;
    const centerY = y * cellH + cellH / 2;

    $r = ((colorRgba >> 24) & 0xFF) / 255;
    $g = ((colorRgba >> 16) & 0xFF) / 255;
    $b = ((colorRgba >> 8) & 0xFF) / 255;

    const left = x * cellW;
    const top = y * cellH;
    switch (style) {
      case 'block':
        this._emitRect(left, top, width * cellW, cellH, centerX, centerY, scale, alpha);
        break;
      case 'bar':
        this._emitRect(left, top, dpr * cursorWidth, cellH, centerX, centerY, scale, alpha);
        break;
      case 'underline':
        this._emitRect(left, (y + 1) * cellH - dpr, width * cellW, dpr, centerX, centerY, scale, alpha);
        break;
      case 'outline': {
        const shapeWidth = width * cellW;
        this._emitRect(left, top, dpr, cellH, centerX, centerY, scale, alpha);
        this._emitRect(left, top + cellH - dpr, shapeWidth, dpr, centerX, centerY, scale, alpha);
        this._emitRect(left, top, shapeWidth, dpr, centerX, centerY, scale, alpha);
        this._emitRect(left + shapeWidth - dpr, top, dpr, cellH, centerX, centerY, scale, alpha);
        break;
      }
    }
  }

  private _emitRect(rx: number, ry: number, rw: number, rh: number, cx: number, cy: number, scale: number, alpha: number): void {
    if (rw <= 0 || rh <= 0) {
      return;
    }
    const x = cx + (rx - cx) * scale;
    const y = cy + (ry - cy) * scale;
    this._writeRect(x, y, rw * scale, rh * scale, alpha);
  }

  /**
   * Writes a rectangle, clipped around the live cursor rectangle when one is
   * excluded. Clipping a rectangle around another produces at most four
   * rectangles (top/bottom bands plus left/right bands).
   */
  private _writeRect(x: number, y: number, width: number, height: number, alpha: number): void {
    if (width <= 0 || height <= 0) {
      return;
    }
    if ($hasExclusion) {
      const ix0 = Math.max(x, $exL);
      const ix1 = Math.min(x + width, $exR);
      const iy0 = Math.max(y, $exT);
      const iy1 = Math.min(y + height, $exB);
      if (ix1 > ix0 && iy1 > iy0) {
        if (y < iy0) {
          this._writeRectRaw(x, y, width, iy0 - y, alpha);
        }
        if (iy1 < y + height) {
          this._writeRectRaw(x, iy1, width, y + height - iy1, alpha);
        }
        if (x < ix0) {
          this._writeRectRaw(x, iy0, ix0 - x, iy1 - iy0, alpha);
        }
        if (ix1 < x + width) {
          this._writeRectRaw(ix1, iy0, x + width - ix1, iy1 - iy0, alpha);
        }
        return;
      }
    }
    this._writeRectRaw(x, y, width, height, alpha);
  }

  private _writeRectRaw(x: number, y: number, width: number, height: number, alpha: number): void {
    const attributes = this._vertices.attributes;
    const offset = this._vertices.count * Constants.FLOATS_PER_RECT;
    if (offset + Constants.FLOATS_PER_RECT > attributes.length) {
      return;
    }
    const canvasWidth = this._dimensions.device.canvas.width;
    const canvasHeight = this._dimensions.device.canvas.height;
    attributes[offset] = x / canvasWidth;
    attributes[offset + 1] = y / canvasHeight;
    attributes[offset + 2] = width / canvasWidth;
    attributes[offset + 3] = height / canvasHeight;
    attributes[offset + 4] = $r;
    attributes[offset + 5] = $g;
    attributes[offset + 6] = $b;
    attributes[offset + 7] = alpha;
    this._vertices.count++;
  }
}
