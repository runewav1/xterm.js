/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Cursor trail geometry model.
 *
 * This is an original TypeScript reimplementation of the built-in cursor trail
 * animation in kitty (https://github.com/kovidgoyal/kitty), specifically
 * `kitty/cursor_trail.c` and `kitty/shaders/trail.slang` at commit
 * 78292b4286f17ed50d45b83b0d6491446573a440. No kitty source is copied here; the
 * equations below were independently derived from that GPLv3 source and are
 * expressed mathematically. See CURSOR_TRAIL.md for the research notes,
 * equivalence mapping and documented deviations.
 *
 * All motion is computed in normalized device canvas coordinates (origin at the
 * top-left, x/y in 0..1). This is a uniform scale of kitty's NDC (origin bottom
 * left, -1..1) so every normalized direction and projection is identical; in
 * particular the cell aspect ratio is preserved because the x and y scales are
 * independent, exactly as in kitty.
 *
 * Scheduling is deliberately single-writer: `setCursor` only records the latest
 * geometry and (re)schedules a single tick, and the tick is the only place that
 * advances motion and requests a render through the shared render service. This
 * keeps the model integrated exactly once per real frame with the real elapsed
 * time, and means synchronized output (DEC 2026) defers the redraw without the
 * model injecting frames behind its back.
 */

import { IRenderDimensions } from '../Types';
import { ICoreBrowserService, IThemeService } from '../../../services/Services';
import { ICoreService } from '../../../../common/services/Services';
import { Disposable, toDisposable } from '../../../../common/Lifecycle';
import { ICursorTrailRawOptions, IResolvedCursorTrailOptions, resolveCursorTrailOptions } from '../../../../common/CursorTrail';
import { ICursorRenderModel, ICursorTrailVertices } from './Types';
import { monotonicNow } from '../../../../common/Time';

/**
 * Corner-to-edge index maps, matching kitty's `corner_index`:
 * corner 0 = (right, top), 1 = (right, bottom), 2 = (left, bottom),
 * 3 = (left, top). `cursor_edge_x = [left, right]`, `cursor_edge_y = [top, bottom]`.
 */
const CORNER_X = [1, 1, 0, 0];
const CORNER_Y = [0, 1, 1, 0];

/**
 * kitty compares corner/edge deltas against `1e-6` in NDC. This model works in
 * normalized canvas coordinates, which are exactly half of NDC, so the
 * equivalent epsilon is `5e-7`.
 */
const EDGE_EPSILON = 5e-7;

// Work arrays reused every frame so animating allocates nothing.
const $dx = [0, 0, 0, 0];
const $dy = [0, 0, 0, 0];
const $dot = [0, 0, 0, 0];

/**
 * Owns the four animated trail corners, the target cursor rectangle and the
 * trail opacity. It never renders; the GPU backends consume the resulting
 * {@link ICursorTrailVertices}. While disabled, reduced-motion, or without a
 * cursor it schedules nothing.
 */
export class CursorTrailModel extends Disposable {
  private _options: IResolvedCursorTrailOptions;
  private readonly _vertices: ICursorTrailVertices = {
    positions: new Float32Array(8),
    cursorRect: new Float32Array(4),
    color: new Float32Array(3),
    opacity: 0,
    visible: false,
    version: 0
  };

  // kitty's CursorTrail state, in normalized canvas coordinates.
  private readonly _cornerX = new Float32Array(4);
  private readonly _cornerY = new Float32Array(4);
  /** `[left, right]`. */
  private readonly _edgeX = new Float32Array(2);
  /** `[top, bottom]`, matching kitty's `cursor_edge_y` ordering. */
  private readonly _edgeY = new Float32Array(2);
  private _opacity = 0;
  /** Clock for corner motion; only advanced by ticks. */
  private _motionAt = 0;
  /** Clock for opacity; advanced analytically on every observation. */
  private _opacityAt = 0;
  private _hasGeometry = false;
  private _needsRender = false;
  private _pendingRetarget = false;

  /** Cursor geometry used for retargeting; independent of blinking. */
  private _cursor: ICursorRenderModel | undefined;
  private _themeColorRgba: number;

  private _frame: number | undefined;
  private _frameWindow: (Window & typeof globalThis) | undefined;
  private _timer: ReturnType<Window['setTimeout']> | undefined;
  private _timerWindow: (Window & typeof globalThis) | undefined;
  /** Absolute time the pending debounce timer is scheduled to fire at. */
  private _timerDeadline = 0;
  private _reducedMotion = false;
  private _reducedMotionQuery: MediaQueryList | undefined;
  private readonly _now: () => number;

  constructor(
    private _dimensions: IRenderDimensions,
    private readonly _coreBrowserService: ICoreBrowserService,
    private readonly _coreService: ICoreService,
    private readonly _themeService: IThemeService,
    private readonly _requestRender: () => void,
    now?: () => number
  ) {
    super();
    this._options = resolveCursorTrailOptions({});
    this._themeColorRgba = this._readThemeColor();
    this._now = now ?? monotonicNow;

    this._register(this._themeService.onChangeColors(() => {
      this._themeColorRgba = this._readThemeColor();
      this._refresh();
    }));
    this._register(this._coreBrowserService.onWindowChange(() => {
      this._cancelScheduled();
      this._bindReducedMotion();
      this.reset();
    }));
    this._register(toDisposable(() => {
      this._reducedMotionQuery?.removeEventListener?.('change', this._handleReducedMotionChange);
      this._reducedMotionQuery = undefined;
      this._cancelScheduled();
    }));
    this._bindReducedMotion();
  }

  public get vertices(): ICursorTrailVertices { return this._vertices; }

  /** Whether the trail can produce any visible pixel with the current options. */
  public get enabled(): boolean { return this._isEnabled; }

  private get _colorAlpha(): number {
    const rgba = this._options.colorRgba ?? this._themeColorRgba;
    return (rgba & 0xFF) / 255;
  }

  private get _isEnabled(): boolean {
    return this._options.stationaryMs > 0 && !this._reducedMotion && this._colorAlpha > 0;
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
    if (!this._isEnabled) {
      this.reset();
    } else {
      this._refresh();
    }
  };

  /** Applies new options and rebuilds any visible geometry immediately. */
  public setOptions(options: ICursorTrailRawOptions): void {
    this._options = resolveCursorTrailOptions(options);
    if (!this._isEnabled) {
      this.reset();
      return;
    }
    const now = this._now();
    this._updateOpacityAnalytic(now);
    this._buildVertices();
    if (this._vertices.visible) {
      this._requestRender();
    }
    // `stationaryMs` or the colour alpha may have changed, so the pending
    // debounce timer (if any) can be stale; re-evaluate it.
    this._cancelTimer();
    this._ensureScheduled(now);
  }

  public setDimensions(dimensions: IRenderDimensions): void {
    this._dimensions = dimensions;
    // Geometry is stored in normalized canvas space, so a resize must drop any
    // in-flight trail rather than re-project stale normalized coordinates.
    this.reset();
  }

  /**
   * Feeds the trail's cursor geometry. `undefined` means the cursor is not
   * available (hidden via DEC private mode 25, outside the viewport, or using
   * the `none` inactive style). Blinking is intentionally ignored here: a blink
   * must not reset trail motion, so callers should pass geometry even while the
   * cursor is blinking off. This method never advances motion or requests a
   * render; it records the observation and schedules a single tick.
   */
  public setCursor(cursor: ICursorRenderModel | undefined): void {
    const now = this._now();
    // Advance opacity against the previous visibility state before recording the
    // new one. Assigning first would attribute the whole preceding interval to
    // the wrong state (visible idle counted as hidden, or hidden time counted as
    // visible).
    if (this._isEnabled) {
      this._updateOpacityAnalytic(now);
    }
    const changed = !sameCursor(this._cursor, cursor);
    this._cursor = cursor;
    if (changed && cursor) {
      this._pendingRetarget = true;
    }
    if (!this._isEnabled) {
      return;
    }
    this._ensureScheduled(now);
  }

  /** Hard clears the trail, forgets the cursor and cancels any scheduled tick. */
  public reset(): void {
    const had = this._vertices.visible || this._hasGeometry || this._frame !== undefined || this._timer !== undefined;
    this._cancelScheduled();
    this._cursor = undefined;
    this._pendingRetarget = false;
    this._hasGeometry = false;
    this._needsRender = false;
    this._opacity = 0;
    this._motionAt = this._now();
    this._opacityAt = this._motionAt;
    this._vertices.visible = false;
    this._vertices.version++;
    if (had) {
      this._requestRender();
    }
  }

  /** Rebuilds vertices after a theme change without disturbing in-flight motion. */
  private _refresh(): void {
    if (!this._isEnabled) {
      this.reset();
      return;
    }
    const now = this._now();
    this._updateOpacityAnalytic(now);
    this._buildVertices();
    if (this._vertices.visible) {
      this._requestRender();
    }
    this._ensureScheduled(now);
  }

  private _debouncePassed(now: number): boolean {
    return this._options.stationaryMs <= now - this._coreService.cursorPositionChangedAt;
  }

  /**
   * Advances the model once. Returns whether a redraw is required (a visible
   * frame changed or a visible trail must be erased).
   */
  private _advance(now: number): boolean {
    if (!this._isEnabled) {
      return false;
    }
    this._updateOpacityAnalytic(now);

    const canvasW = this._dimensions.device.canvas.width;
    const canvasH = this._dimensions.device.canvas.height;
    const cellW = this._dimensions.device.cell.width;
    const cellH = this._dimensions.device.cell.height;
    const gdx = cellW / canvasW;
    const gdy = cellH / canvasH;
    if (!(gdx > 0) || !(gdy > 0)) {
      this._motionAt = now;
      this._buildVertices();
      return false;
    }

    if (!this._hasGeometry) {
      if (this._cursor && this._debouncePassed(now)) {
        this._updateTarget(this._cursor);
        this._pendingRetarget = false;
      }
      this._motionAt = now;
      this._buildVertices();
      return false;
    }

    const wasAnimating = this._needsRender;
    let targetChanged = false;
    if (this._cursor && this._debouncePassed(now)) {
      targetChanged = this._updateTarget(this._cursor);
      this._pendingRetarget = false;
    }

    // Consume the real elapsed time for motion, except for a fresh start after
    // the cursor has been idle: there the idle gap must not snap the corners to
    // the new target, so the first step uses dt = 0 and later frames animate.
    const dt = Math.max(0, (now - this._motionAt) / 1000);
    this._updateCorners(gdx, gdy, targetChanged && !wasAnimating ? 0 : dt);
    this._motionAt = now;

    const needsRenderPrev = this._needsRender;
    this._updateNeedsRender();
    this._buildVertices();

    return this._needsRender || needsRenderPrev;
  }

  /**
   * Updates the target rectangle. Returns whether the target changed. On first
   * observation the corners snap to the target so no phantom trail appears from
   * the origin.
   */
  private _updateTarget(cursor: ICursorRenderModel): boolean {
    const canvasW = this._dimensions.device.canvas.width;
    const canvasH = this._dimensions.device.canvas.height;
    const cellW = this._dimensions.device.cell.width;
    const cellH = this._dimensions.device.cell.height;
    if (!(canvasW > 0) || !(canvasH > 0) || !(cellW > 0) || !(cellH > 0)) {
      return false;
    }

    const left = Math.fround(cursor.x * cellW / canvasW);
    const top = Math.fround(cursor.y * cellH / canvasH);
    const bottom = Math.fround((cursor.y + 1) * cellH / canvasH);
    let right: number;
    let edgeTop = top;
    switch (cursor.style) {
      case 'bar':
        // xterm's bar cursor is `dpr * cursorWidth` device pixels wide.
        right = Math.fround(left + (cursor.dpr * cursor.cursorWidth) / canvasW);
        break;
      case 'underline':
        right = Math.fround((cursor.x + cursor.width) * cellW / canvasW);
        edgeTop = Math.fround(bottom - cursor.dpr / canvasH);
        break;
      case 'block':
      case 'outline':
      default:
        // xterm adaptation: use the real wide-cursor bounds instead of kitty's
        // single-cell width.
        right = Math.fround((cursor.x + cursor.width) * cellW / canvasW);
        break;
    }

    let changed = false;
    if (this._edgeX[0] !== left || this._edgeX[1] !== right || this._edgeY[0] !== edgeTop || this._edgeY[1] !== bottom) {
      this._edgeX[0] = left;
      this._edgeX[1] = right;
      this._edgeY[0] = edgeTop;
      this._edgeY[1] = bottom;
      changed = true;
    }

    if (!this._hasGeometry) {
      this._snapCorners();
      this._hasGeometry = true;
      changed = true;
    }
    return changed;
  }

  private _snapCorners(): void {
    for (let i = 0; i < 4; i++) {
      this._cornerX[i] = this._edgeX[CORNER_X[i]];
      this._cornerY[i] = this._edgeY[CORNER_Y[i]];
    }
  }

  /**
   * Per-corner exponential ease-out. Each corner's decay is blended between
   * `decayFast` and `decaySlow` by the normalized projection of its motion onto
   * the cursor centre, so corners moving along the direction of travel catch up
   * faster than trailing corners.
   */
  private _updateCorners(gdx: number, gdy: number, dt: number): void {
    const thresholdActive = this._options.thresholdX > 0 || this._options.thresholdY > 0;
    let skip = false;
    if (!this._cursor && this._opacity <= 0) {
      skip = true;
    } else if (thresholdActive && !this._needsRender) {
      // kitty measures the previous top-right corner (corner 0) against the new
      // right and top edges in whole cells, using C's round (ties away from
      // zero). Taking the absolute value first makes JS Math.round equivalent
      // because round is an odd function.
      const dxCells = Math.round(Math.abs((this._cornerX[0] - this._edgeX[1]) / gdx));
      const dyCells = Math.round(Math.abs((this._cornerY[0] - this._edgeY[0]) / gdy));
      if (dxCells <= this._options.thresholdX && dyCells <= this._options.thresholdY) {
        skip = true;
      }
    }

    if (skip) {
      this._snapCorners();
      return;
    }
    if (!(dt > 0)) {
      return;
    }

    const centerX = (this._edgeX[0] + this._edgeX[1]) * 0.5;
    const centerY = (this._edgeY[0] + this._edgeY[1]) * 0.5;
    const edgeDx = this._edgeX[1] - this._edgeX[0];
    const edgeDy = this._edgeY[1] - this._edgeY[0];
    const diag2 = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) * 0.5;

    for (let i = 0; i < 4; i++) {
      const ax = this._edgeX[CORNER_X[i]];
      const ay = this._edgeY[CORNER_Y[i]];
      const dxi = ax - this._cornerX[i];
      const dyi = ay - this._cornerY[i];
      if (Math.abs(dxi) < EDGE_EPSILON && Math.abs(dyi) < EDGE_EPSILON) {
        $dx[i] = 0;
        $dy[i] = 0;
        $dot[i] = 0;
        continue;
      }
      const length = Math.sqrt(dxi * dxi + dyi * dyi);
      const denom = (diag2 > 0 ? diag2 : 1) * length;
      $dx[i] = dxi;
      $dy[i] = dyi;
      $dot[i] = denom > 0 ? (dxi * (ax - centerX) + dyi * (ay - centerY)) / denom : 0;
    }

    // kitty computes min/max over all four dots in a separate pass, so corners
    // that are already on target contribute their dot of 0 to the range.
    let minDot = Infinity;
    let maxDot = -Infinity;
    for (let i = 0; i < 4; i++) {
      if ($dot[i] < minDot) {
        minDot = $dot[i];
      }
      if ($dot[i] > maxDot) {
        maxDot = $dot[i];
      }
    }

    const fast = this._options.decayFast;
    const slow = this._options.decaySlow;
    const span = maxDot - minDot;
    for (let i = 0; i < 4; i++) {
      if ($dx[i] === 0 && $dy[i] === 0) {
        continue;
      }
      const decay = span === 0 ? slow : slow + (fast - slow) * ($dot[i] - minDot) / span;
      // An explicit zero decay (or a zero dt) snaps without producing NaN.
      const step = decay > 0 ? 1 - Math.pow(2, -10 * dt / decay) : 1;
      this._cornerX[i] += $dx[i] * step;
      this._cornerY[i] += $dy[i] * step;
    }
  }

  private _updateOpacity(dt: number): void {
    const rate = this._options.decaySlow;
    if (!(rate > 0)) {
      this._opacity = this._cursor ? 1 : 0;
      return;
    }
    if (this._cursor) {
      this._opacity = Math.min(1, this._opacity + dt / rate);
    } else {
      this._opacity = Math.max(0, this._opacity - dt / rate);
    }
  }

  private _updateOpacityAnalytic(now: number): void {
    const dt = Math.max(0, (now - this._opacityAt) / 1000);
    this._updateOpacity(dt);
    this._opacityAt = now;
  }

  /**
   * The trail keeps animating while any corner is at least half a device pixel
   * from its target, matching kitty's settle threshold of `g.dx / cell_width *
   * 0.5` (which equals half a device pixel).
   */
  private _updateNeedsRender(): void {
    this._needsRender = false;
    const dxThreshold = 0.5 / this._dimensions.device.canvas.width;
    const dyThreshold = 0.5 / this._dimensions.device.canvas.height;
    for (let i = 0; i < 4; i++) {
      const ax = this._edgeX[CORNER_X[i]];
      const ay = this._edgeY[CORNER_Y[i]];
      if (Math.abs(ax - this._cornerX[i]) >= dxThreshold || Math.abs(ay - this._cornerY[i]) >= dyThreshold) {
        this._needsRender = true;
        break;
      }
    }
  }

  private _buildVertices(): void {
    if (!this._hasGeometry) {
      this._vertices.visible = false;
      this._vertices.version++;
      return;
    }
    const positions = this._vertices.positions;
    for (let i = 0; i < 4; i++) {
      positions[i * 2] = this._cornerX[i];
      positions[i * 2 + 1] = this._cornerY[i];
    }
    const rect = this._vertices.cursorRect;
    rect[0] = this._edgeX[0];
    rect[1] = this._edgeY[0];
    rect[2] = this._edgeX[1];
    rect[3] = this._edgeY[1];

    const rgba = this._options.colorRgba ?? this._themeColorRgba;
    const color = this._vertices.color;
    color[0] = ((rgba >> 24) & 0xFF) / 255;
    color[1] = ((rgba >> 16) & 0xFF) / 255;
    color[2] = ((rgba >> 8) & 0xFF) / 255;

    // Host extension over kitty: the resolved colour's alpha is folded into the
    // rendered opacity (kitty ignores the colour alpha). An alpha of 0 disables
    // the effect entirely via `_isEnabled`.
    const opacity = this._opacity * this._colorAlpha;
    this._vertices.opacity = opacity;
    // Only a genuinely moving trail needs GPU work: once settled there is
    // nothing visible (the quad collapses behind the masked cursor rectangle).
    this._vertices.visible = this._needsRender && opacity > 0;
    this._vertices.version++;
  }

  /**
   * Schedules at most one pending tick, re-evaluating any existing schedule so
   * an option or cursor change cannot leave a stale timer pending. Motion uses
   * `requestAnimationFrame`; waiting out the input debounce uses a single
   * cancellable timeout whose deadline is tracked, so rapid churn keeps exactly
   * one bounded timer rather than accumulating or keeping an obsolete one.
   */
  private _ensureScheduled(now: number): void {
    if (!this._isEnabled) {
      return;
    }
    const debouncePassed = this._cursor === undefined || this._debouncePassed(now);
    const needFrame = this._needsRender
      || (this._cursor !== undefined && debouncePassed && (!this._hasGeometry || this._pendingRetarget));
    if (needFrame) {
      // Movement is due, so any debounce timer is obsolete.
      this._cancelTimer();
      this._ensureFrame();
      return;
    }
    if (this._cursor !== undefined && !debouncePassed) {
      const desired = this._coreService.cursorPositionChangedAt + this._options.stationaryMs;
      if (this._timer !== undefined && Math.abs(this._timerDeadline - desired) <= 1) {
        return;
      }
      // The pending frame is not needed while merely waiting, and the existing
      // timer may be stale after a change to the cursor or `stationaryMs`.
      this._cancelFrame();
      this._cancelTimer();
      this._ensureTimer(desired - now, now);
      return;
    }
    // Nothing to do: drop any stale timer.
    this._cancelTimer();
  }

  private _ensureFrame(): void {
    if (this._frame !== undefined) {
      return;
    }
    const parentWindow = this._coreBrowserService.window;
    if (typeof parentWindow.requestAnimationFrame !== 'function') {
      return;
    }
    this._frameWindow = parentWindow;
    this._frame = parentWindow.requestAnimationFrame(this._tick);
  }

  private _ensureTimer(delayMs: number, now: number): void {
    if (this._timer !== undefined) {
      return;
    }
    const parentWindow = this._coreBrowserService.window;
    if (typeof parentWindow.setTimeout !== 'function') {
      return;
    }
    // setTimeout overflows delays greater than 2^31-1 to ~1ms, so clamp the
    // chunk and re-evaluate the remaining delay when the timer wakes.
    const capped = Math.min(Math.max(1, delayMs), 2147483647);
    this._timerWindow = parentWindow;
    this._timerDeadline = now + capped;
    this._timer = parentWindow.setTimeout(this._handleTimer, capped);
  }

  private _cancelScheduled(): void {
    this._cancelFrame();
    this._cancelTimer();
  }

  private _cancelFrame(): void {
    if (this._frame === undefined) {
      return;
    }
    this._frameWindow?.cancelAnimationFrame?.(this._frame);
    this._frame = undefined;
    this._frameWindow = undefined;
  }

  private _cancelTimer(): void {
    if (this._timer !== undefined) {
      this._timerWindow?.clearTimeout?.(this._timer);
      this._timer = undefined;
      this._timerWindow = undefined;
    }
    this._timerDeadline = 0;
  }

  private _tick = (): void => {
    this._frame = undefined;
    this._frameWindow = undefined;
    if (!this._isEnabled) {
      return;
    }
    const now = this._now();
    const dirty = this._advance(now);
    if (dirty) {
      this._requestRender();
    }
    this._ensureScheduled(now);
  };

  private _handleTimer = (): void => {
    this._timer = undefined;
    this._timerWindow = undefined;
    this._timerDeadline = 0;
    if (!this._isEnabled) {
      return;
    }
    const now = this._now();
    const dirty = this._advance(now);
    if (dirty) {
      this._requestRender();
    }
    this._ensureScheduled(now);
  };
}

function sameCursor(a: ICursorRenderModel | undefined, b: ICursorRenderModel | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.x === b.x && a.y === b.y && a.width === b.width && a.style === b.style && a.cursorWidth === b.cursorWidth && a.dpr === b.dpr;
}
