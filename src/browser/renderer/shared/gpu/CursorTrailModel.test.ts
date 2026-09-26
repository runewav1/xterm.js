/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Equation-parity and scheduling tests for the cursor trail. The reference
 * implementation in this file is a second, independent translation of the
 * equations in kitty's `cursor_trail.c` (commit
 * 78292b4286f17ed50d45b83b0d6491446573a440) used to pin the production
 * implementation.
 */

import { assert } from 'chai';
import { DisposableStore } from '../../../../common/Lifecycle';
import { Emitter } from '../../../../common/Event';
import { css } from '../../../../common/Color';
import { MockCoreService } from '../../../../common/TestUtils.test';
import type { ICoreBrowserService, IThemeService } from '../../../services/Services';
import type { IRenderDimensions } from '../Types';
import type { ICursorRenderModel } from './Types';
import { CursorTrailModel } from './CursorTrailModel';

const CORNER_X = [1, 1, 0, 0];
const CORNER_Y = [0, 1, 1, 0];
const EPS = 5e-7;

interface IEdges {
  x: [number, number];
  y: [number, number];
}

/** Independent translation of kitty's corner update. Mutates the corners. */
function referenceCorners(cornerX: number[], cornerY: number[], edges: IEdges, fast: number, slow: number, dt: number): void {
  const centerX = (edges.x[0] + edges.x[1]) * 0.5;
  const centerY = (edges.y[0] + edges.y[1]) * 0.5;
  const diag2 = Math.hypot(edges.x[1] - edges.x[0], edges.y[1] - edges.y[0]) * 0.5;
  const dx = [0, 0, 0, 0];
  const dy = [0, 0, 0, 0];
  const dot = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const ax = edges.x[CORNER_X[i]];
    const ay = edges.y[CORNER_Y[i]];
    const dxi = ax - cornerX[i];
    const dyi = ay - cornerY[i];
    if (Math.abs(dxi) < EPS && Math.abs(dyi) < EPS) {
      continue;
    }
    dx[i] = dxi;
    dy[i] = dyi;
    const length = Math.hypot(dxi, dyi);
    dot[i] = (dxi * (ax - centerX) + dyi * (ay - centerY)) / (diag2 > 0 ? diag2 : 1) / length;
  }
  let minDot = Infinity;
  let maxDot = -Infinity;
  for (let i = 0; i < 4; i++) {
    minDot = Math.min(minDot, dot[i]);
    maxDot = Math.max(maxDot, dot[i]);
  }
  const span = maxDot - minDot;
  for (let i = 0; i < 4; i++) {
    if (dx[i] === 0 && dy[i] === 0) {
      continue;
    }
    const decay = span === 0 ? slow : slow + (fast - slow) * (dot[i] - minDot) / span;
    const step = decay > 0 ? 1 - Math.pow(2, -10 * dt / decay) : 1;
    cornerX[i] += dx[i] * step;
    cornerY[i] += dy[i] * step;
  }
}

/** Convex polygon containment (works for the sheared/parallelogram trail quad). */
function pointInQuad(px: number, py: number, xs: number[], ys: number[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const cross = (xs[j] - xs[i]) * (py - ys[i]) - (ys[j] - ys[i]) * (px - xs[i]);
    if (Math.abs(cross) < 1e-12) {
      continue;
    }
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) {
      sign = s;
    } else if (s !== sign) {
      return false;
    }
  }
  return true;
}

class FakeWindow {
  public time = 0;
  public reducedMotion = false;
  public canceled = 0;
  public readonly rafCallbacks = new Map<number, FrameRequestCallback>();
  public readonly timers = new Map<number, () => void>();
  public lastTimeoutDelay = 0;
  private _nextId = 1;
  private readonly _mediaListeners = new Set<() => void>();

  public readonly performance = { now: (): number => this.time };

  public requestAnimationFrame(callback: FrameRequestCallback): number {
    const id = this._nextId++;
    this.rafCallbacks.set(id, callback);
    return id;
  }

  public cancelAnimationFrame(id: number): void {
    if (this.rafCallbacks.delete(id)) {
      this.canceled++;
    }
  }

  public setTimeout(callback: () => void, delay: number): number {
    const id = this._nextId++;
    this.lastTimeoutDelay = delay;
    this.timers.set(id, callback);
    return id;
  }

  public clearTimeout(id: number): void {
    if (this.timers.delete(id)) {
      this.canceled++;
    }
  }

  /** Runs all currently pending timers once, then all pending rAF callbacks. */
  public flush(): void {
    const timers = Array.from(this.timers.values());
    this.timers.clear();
    for (const timer of timers) {
      timer();
    }
    const rafs = Array.from(this.rafCallbacks.values());
    this.rafCallbacks.clear();
    for (const raf of rafs) {
      raf(0);
    }
  }

  public matchMedia(query: string): MediaQueryList {
    const self = this;
    return {
      media: query,
      get matches(): boolean { return self.reducedMotion; },
      addEventListener: (_type: string, listener: () => void) => self._mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => self._mediaListeners.delete(listener)
    } as unknown as MediaQueryList;
  }

  public setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
    for (const listener of Array.from(this._mediaListeners)) {
      listener();
    }
  }
}

class FakeCoreBrowserService implements Partial<ICoreBrowserService> {
  public serviceBrand: undefined;
  public isFocused = true;
  public dpr = 1;
  public onDprChange = new Emitter<number>().event;
  public readonly windowChange = new Emitter<Window & typeof globalThis>();
  public readonly onWindowChange = this.windowChange.event;
  public mainDocument = {} as Document;
  private _window: Window & typeof globalThis;

  constructor(window: FakeWindow) {
    this._window = window as unknown as Window & typeof globalThis;
  }

  public get window(): Window & typeof globalThis { return this._window; }
}

function createThemeService(): IThemeService {
  const themeChanges = new Emitter<IThemeService['colors']>();
  return {
    serviceBrand: undefined,
    onChangeColors: themeChanges.event,
    colors: { cursor: css.toColor('#ffffff') },
    restoreColor: () => {},
    modifyColors: () => {}
  } as unknown as IThemeService;
}

const COLS = 8;
const ROWS = 4;
const CELL_WIDTH = 10;
const CELL_HEIGHT = 20;

function createDimensions(cols = COLS, rows = ROWS, cellWidth = CELL_WIDTH, cellHeight = CELL_HEIGHT): IRenderDimensions {
  return {
    css: { canvas: { width: cols * cellWidth, height: rows * cellHeight }, cell: { width: cellWidth, height: cellHeight } },
    device: {
      canvas: { width: cols * cellWidth, height: rows * cellHeight },
      cell: { width: cellWidth, height: cellHeight },
      char: { width: cellWidth, height: cellHeight, left: 0, top: 0 }
    }
  };
}

function cursor(x: number, y: number, style: ICursorRenderModel['style'] = 'block', width = 1): ICursorRenderModel {
  return { x, y, width, style, cursorWidth: 1, dpr: 1 };
}

describe('CursorTrailModel', () => {
  let store: DisposableStore;
  let window: FakeWindow;
  let coreBrowser: FakeCoreBrowserService;
  let coreService: MockCoreService;
  let theme: IThemeService;
  let model: CursorTrailModel;
  let renderRequests: number;

  function createModel(dimensions = createDimensions()): CursorTrailModel {
    return store.add(new CursorTrailModel(
      dimensions,
      coreBrowser as unknown as ICoreBrowserService,
      coreService,
      theme,
      () => renderRequests++,
      () => window.time
    ));
  }

  function observe(c: ICursorRenderModel | undefined): void {
    model.setCursor(c);
  }

  /** Advances time and runs pending scheduling work once. */
  function stepTo(t: number): void {
    window.time = t;
    window.flush();
  }

  function cornerX(): number[] {
    return Array.from((model as any)._cornerX as Float32Array);
  }
  function cornerY(): number[] {
    return Array.from((model as any)._cornerY as Float32Array);
  }
  function edges(): IEdges {
    const x = Array.from((model as any)._edgeX as Float32Array);
    const y = Array.from((model as any)._edgeY as Float32Array);
    return { x: [x[0], x[1]], y: [y[0], y[1]] };
  }
  function assertCornerClose(expectedX: number[], expectedY: number[], tolerance: number, actualX = cornerX(), actualY = cornerY()): void {
    for (let i = 0; i < 4; i++) {
      assert.closeTo(actualX[i], expectedX[i], tolerance, `corner ${i} x`);
      assert.closeTo(actualY[i], expectedY[i], tolerance, `corner ${i} y`);
    }
  }

  /** Establishes the geometry baseline at (0,0) and leaves a settled state. */
  function baseline(): void {
    observe(cursor(0, 0));
    stepTo(0);
  }

  beforeEach(() => {
    store = new DisposableStore();
    window = new FakeWindow();
    coreBrowser = new FakeCoreBrowserService(window);
    coreService = new MockCoreService();
    coreService.cursorPositionChangedAt = -100000;
    theme = createThemeService();
    renderRequests = 0;
    model = createModel();
  });

  afterEach(() => store.dispose());

  describe('equation parity', () => {
    it('matches an independently calculated horizontal trace', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(2, 0));
      stepTo(100);
      // Fresh start consumes the idle gap as dt = 0, so no motion yet.
      assert.deepEqual(cornerX(), [0.125, 0.125, 0, 0]);
      stepTo(200);
      const step = 1 - Math.pow(2, -10 * 0.1 / 0.4);
      assert.closeTo(cornerX()[0], 0.125 + 0.25 * step, 1e-5);
      assert.closeTo(cornerX()[1], 0.125 + 0.25 * step, 1e-5);
      assert.closeTo(cornerX()[2], 0.25 * step, 1e-5);
      assert.closeTo(cornerX()[3], 0.25 * step, 1e-5);
      assert.deepEqual(cornerY(), [0, 0.25, 0.25, 0]);
    });

    it('matches the reference for vertical and diagonal movement', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.3, 0.5], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(0, 2));
      stepTo(100);
      stepTo(180);
      const expectedX = [0.125, 0.125, 0, 0];
      const expectedY = [0, 0.25, 0.25, 0];
      referenceCorners(expectedX, expectedY, { x: [0, 0.125], y: [0.5, 0.75] }, 0.3, 0.5, 0.08);
      assertCornerClose(expectedX, expectedY, 2e-5);

      model = createModel();
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.3, 0.5], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(2, 2));
      stepTo(100);
      stepTo(180);
      const diagX = [0.125, 0.125, 0, 0];
      const diagY = [0, 0.25, 0.25, 0];
      referenceCorners(diagX, diagY, { x: [0.25, 0.375], y: [0.5, 0.75] }, 0.3, 0.5, 0.08);
      assertCornerClose(diagX, diagY, 2e-5);
    });

    it('includes stationary corners in the min/max dot range', () => {
      // A vertical-only move leaves the x delta of all corners equal, but the
      // y delta differs per corner. The reference (separate min/max pass) is the
      // ground truth; this locks the two-pass behaviour.
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.3, 0.5], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(0, 1));
      stepTo(100);
      stepTo(160);
      const expectedX = [0.125, 0.125, 0, 0];
      const expectedY = [0, 0.25, 0.25, 0];
      referenceCorners(expectedX, expectedY, { x: [0, 0.125], y: [0.25, 0.5] }, 0.3, 0.5, 0.06);
      assertCornerClose(expectedX, expectedY, 2e-5);
    });

    it('continues from the current geometry across rapid retargets', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(2, 0));
      stepTo(0);
      stepTo(50);
      const midX = cornerX();
      const midY = cornerY();
      // Retarget mid-flight: the corners must continue from where they are, not
      // teleport back to the previous accepted cell.
      observe(cursor(4, 2));
      stepTo(100);
      referenceCorners(midX, midY, { x: [0.5, 0.625], y: [0.5, 0.75] }, 0.4, 0.4, 0.05);
      assertCornerClose(midX, midY, 2e-5);
    });

    it('is exactly additive in time (exponential ease-out)', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.35, 0.7], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(3, 1));
      stepTo(0);
      stepTo(100);
      stepTo(160);
      const twoStepX = cornerX();
      const twoStepY = cornerY();

      model = createModel();
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.35, 0.7], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(3, 1));
      stepTo(0);
      stepTo(160);
      assertCornerClose(cornerX(), cornerY(), 1e-5, twoStepX, twoStepY);
    });

    it('preserves geometry across a reversal instead of teleporting', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(3, 0));
      stepTo(0);
      stepTo(60);
      const beforeX = cornerX();
      const beforeY = cornerY();

      observe(cursor(0, 0));
      stepTo(120);
      const cx = cornerX();
      const cy = cornerY();
      assert.notDeepEqual(cx, [0.125, 0.125, 0, 0]);
      assert.notDeepEqual(cx, beforeX);
      referenceCorners(beforeX, beforeY, { x: [0, 0.125], y: [0, 0.25] }, 0.4, 0.4, 0.06);
      assertCornerClose(beforeX, beforeY, 2e-5, cx, cy);
    });

    it('settles within half a device pixel of the target', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.1, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(5, 0));
      stepTo(0);
      stepTo(100000);
      assert.deepEqual(cornerX(), [0.75, 0.75, 0.625, 0.625]);
      assert.deepEqual(cornerY(), [0, 0.25, 0.25, 0]);
      assert.isFalse((model as any)._needsRender);
    });

    it('does not report a target change for repeated fractional positions', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      observe(cursor(0.1, 0.2));
      stepTo(0); // establish geometry
      const changed = (model as any)._updateTarget({ x: 0.1, y: 0.2, width: 1, style: 'block', cursorWidth: 1, dpr: 1 });
      assert.isFalse(changed, 'a stable fractional snapshot must not report a change');
      // A repeat observation must not reset motion or schedule extra work.
      stepTo(100);
      const settled = cornerX();
      observe(cursor(0.1, 0.2));
      stepTo(200);
      assert.deepEqual(cornerX(), settled);
      assert.isUndefined((model as any)._frame);
      assert.isUndefined((model as any)._timer);
    });

    it('produces a sheared quad, not a bounding box, for a diagonal move', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(2, 2));
      stepTo(0);
      // One 40ms tick gives a 0.5 interpolation between the old and new cells.
      stepTo(40);
      const xs = [cornerX()[0], cornerX()[1], cornerX()[2], cornerX()[3]];
      const ys = [cornerY()[0], cornerY()[1], cornerY()[2], cornerY()[3]];
      // The diagonal midpoint is covered...
      assert.isTrue(pointInQuad(0.1875, 0.375, xs, ys), 'diagonal midpoint should be inside the quad');
      // ...while the corners of the bounding box are not, which distinguishes a
      // sheared quad from an axis-aligned ghost/bounding rectangle.
      assert.isFalse(pointInQuad(0.375, 0, xs, ys), 'top-right bbox corner should be outside');
      assert.isFalse(pointInQuad(0, 0.75, xs, ys), 'bottom-left bbox corner should be outside');
    });
  });

  describe('start threshold', () => {
    it('snaps without animating when the move is within the threshold', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 2 });
      baseline();
      observe(cursor(1, 0));
      stepTo(50);
      assert.deepEqual(cornerX(), [0.25, 0.25, 0.125, 0.125]);
      assert.isFalse((model as any)._needsRender);
    });

    it('uses away-from-zero rounding for negative half-cell deltas', () => {
      // Moving left by exactly half a cell: delta = -0.5 * gdx. C's round gives
      // -1 (abs 1); JS Math.round(-0.5) gives -0. The implementation rounds the
      // absolute delta, so the move counts as one cell and is between the
      // threshold of 1 and 2.
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 1 });
      rendererClampThresholdHalfCell();
    });

    it('animates when the move exceeds the threshold', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 2 });
      baseline();
      observe(cursor(3, 0));
      stepTo(0);
      stepTo(50);
      assert.ok((model as any)._needsRender);
    });
  });

  describe('debounce and scheduling', () => {
    it('waits out the debounce with a timeout rather than animation frames', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      coreService.cursorPositionChangedAt = 0;
      observe(cursor(3, 0));
      assert.isDefined((model as any)._timer, 'a debounce timer is scheduled');
      assert.isUndefined((model as any)._frame, 'no animation frame is scheduled while waiting');
      stepTo(50);
      assert.deepEqual(edges().x, [0, 0.125], 'within the window the target is unchanged');
      stepTo(101);
      assert.deepEqual(edges().x, [0.375, 0.5], 'the target updates once the debounce elapses');
    });

    it('re-evaluates a stale debounce timer when stationaryMs decreases', () => {
      model.setOptions({ cursorTrail: 1, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      coreService.cursorPositionChangedAt = -100000;
      baseline();
      coreService.cursorPositionChangedAt = 0;
      model.setOptions({ cursorTrail: 100000, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      observe(cursor(3, 0));
      assert.isDefined((model as any)._timer);
      assert.closeTo((model as any)._timerDeadline, 100000, 1);
      model.setOptions({ cursorTrail: 50, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      assert.closeTo((model as any)._timerDeadline, 50, 1, 'timer rescheduled to the new deadline');
      stepTo(51);
      assert.deepEqual(edges().x, [0.375, 0.5], 'the reduced debounce elapsed');
    });

    it('caps the debounce timeout chunk at 2^31-1 ms', () => {
      model.setOptions({ cursorTrail: 1, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      coreService.cursorPositionChangedAt = -100000;
      baseline();
      coreService.cursorPositionChangedAt = 0;
      model.setOptions({ cursorTrail: 10_000_000_000, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      observe(cursor(3, 0));
      assert.isAtMost(window.lastTimeoutDelay, 2147483647);
      assert.isAbove(window.lastTimeoutDelay, 0);
    });

    it('keeps a single bounded debounce timer under rapid cursor churn', () => {
      model.setOptions({ cursorTrail: 1, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      coreService.cursorPositionChangedAt = -100000;
      baseline();
      coreService.cursorPositionChangedAt = 1000;
      model.setOptions({ cursorTrail: 1000, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      for (let i = 0; i < 10; i++) {
        observe(cursor(i % 5, 0));
      }
      assert.strictEqual(window.timers.size, 1, 'exactly one timer is pending');
      assert.isUndefined((model as any)._frame, 'no frame accumulates during the debounce');
    });

    it('advances exactly once per scheduled tick and never on observation', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      const before = cornerX();
      renderRequests = 0;
      observe(cursor(3, 0));
      assert.deepEqual(cornerX(), before, 'observation must not advance motion');
      assert.strictEqual(renderRequests, 0, 'observation must not request a render');
      stepTo(100);
      assert.strictEqual(renderRequests, 1, 'one tick requests one render');
      const afterOne = cornerX();
      stepTo(200);
      assert.strictEqual(renderRequests, 2, 'the next tick requests one more render');
      assert.notDeepEqual(cornerX(), afterOne);
    });

    it('does not allocate frames or require GPU work while enabled but settled', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(2, 0));
      stepTo(0);
      stepTo(1000);
      assert.isUndefined((model as any)._frame);
      assert.isUndefined((model as any)._timer);
      assert.isFalse(model.vertices.visible, 'settled trail must not draw');
    });

    it('keeps the trail visible after a long idle before the first move', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      // Long idle: opacity must catch up analytically, and the idle gap must not
      // snap the new target on acceptance.
      stepTo(100000);
      observe(cursor(4, 0));
      stepTo(100000);
      assert.isTrue((model as any)._needsRender, 'the first move after idle must animate');
      assert.ok(model.vertices.visible, 'the trail must be visible at the start of the move');
      assert.closeTo(model.vertices.opacity, 1, 1e-6);
      assert.notDeepEqual(cornerX(), [0.625, 0.625, 0.5, 0.5], 'corners must not snap to the new target');
    });
  });

  describe('opacity and lifecycle', () => {
    it('fades opacity out without hard clearing while the cursor is hidden mid-motion', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.1, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      // Warm opacity to 1 while stationary.
      stepTo(1000);
      observe(cursor(0, 0));
      observe(cursor(3, 0));
      stepTo(1000);
      stepTo(1040);
      const geometryBefore = (model as any)._hasGeometry;
      const opacityBefore = model.vertices.opacity;
      assert.isAbove(opacityBefore, 0.9);

      observe(undefined);
      stepTo(1080);
      assert.strictEqual((model as any)._hasGeometry, geometryBefore, 'hide must not reset geometry');
      assert.isBelow(model.vertices.opacity, opacityBefore, 'hidden cursor fades opacity');

      // Once fully faded the corners snap and scheduling stops, even though the
      // erase is still requested once.
      stepTo(100000);
      assert.strictEqual(model.vertices.opacity, 0);
      assert.isFalse(model.vertices.visible);
      assert.isFalse((model as any)._needsRender, 'no unbounded hidden loop');
      assert.isUndefined((model as any)._frame);
      assert.isUndefined((model as any)._timer);
    });

    it('attributes a visible idle interval to the visible state before a hide', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.1, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      // Long visible idle with no observations, then hide in one step.
      stepTo(5000);
      observe(undefined);
      // The idle gap must have ramped opacity up while visible before the hide.
      assert.closeTo((model as any)._opacity, 1, 1e-6);
      // A later tick then decays it.
      (model as any)._advance(5020);
      assert.isBelow((model as any)._opacity, 1, 'opacity decays after the hide');
    });

    it('attributes a hidden interval to the hidden state before showing', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.1, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      stepTo(1000);
      observe(cursor(0, 0)); // ramp opacity to 1 while visible
      assert.closeTo((model as any)._opacity, 1, 1e-6);
      observe(undefined);
      // Long hidden interval with no scheduled work, then show in one step.
      stepTo(2000);
      observe(cursor(3, 0));
      assert.strictEqual((model as any)._opacity, 0, 'hidden interval decays opacity before the show');
      stepTo(2020);
      assert.isAbove((model as any)._opacity, 0, 'opacity ramps after the cursor returns');
    });

    it('hard clears and forgets the cursor on dimension change', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(2, 0));
      stepTo(100);
      assert.isTrue((model as any)._hasGeometry);
      model.setDimensions(createDimensions(4, 4));
      assert.isFalse((model as any)._hasGeometry);
      assert.isUndefined((model as any)._cursor);
      assert.isFalse(model.vertices.visible);
    });

    it('does not schedule stale motion when a theme change follows a viewport hide', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 0 });
      baseline();
      observe(cursor(2, 0));
      stepTo(100);
      model.reset();
      assert.isUndefined((model as any)._cursor);
      // Simulate a theme refresh after the reset.
      (model as any)._refresh();
      assert.isUndefined((model as any)._frame);
      assert.isUndefined((model as any)._timer);
      assert.isFalse(model.vertices.visible);
    });

    it('is disabled while reduced motion is requested', () => {
      window.setReducedMotion(true);
      model.setOptions({ cursorTrail: 100 });
      baseline();
      observe(cursor(3, 0));
      stepTo(100);
      assert.isFalse((model as any)._hasGeometry);
      assert.isFalse(model.vertices.visible);
    });

    it('folds a colour override alpha into the rendered opacity and skips transparent colours', () => {
      model.setOptions({ cursorTrail: 100, cursorTrailColor: '#ff000080', cursorTrailStartThreshold: 0 });
      baseline();
      // Warm opacity to 1 while stationary, then move.
      stepTo(1000);
      observe(cursor(0, 0));
      observe(cursor(2, 0));
      stepTo(1000);
      stepTo(1040);
      const opaque = model.vertices.opacity;
      assert.closeTo(opaque, 128 / 255, 1e-3, 'override alpha multiplies rendered opacity');
      assert.deepEqual(Array.from(model.vertices.color), [1, 0, 0]);

      model.setOptions({ cursorTrail: 100, cursorTrailColor: '#ff000000', cursorTrailStartThreshold: 0 });
      assert.isFalse(model.enabled, 'fully transparent colour disables the trail');
      assert.isFalse(model.vertices.visible);
      assert.isUndefined((model as any)._frame);
    });
  });

  // Helper used by the away-from-zero rounding test; split out to keep the
  // threshold test readable.
  function rendererClampThresholdHalfCell(): void {
    const dims = createDimensions(8, 4);
    model = createModel(dims);
    model.setOptions({ cursorTrail: 100, cursorTrailDecay: [0.4, 0.4], cursorTrailStartThreshold: 1 });
    // Baseline at x = 1, then move left by half a cell (delta = -0.5 * gdx with
    // gdx = 1/8, so -0.0625). Away-from-zero rounding makes this one cell and
    // the threshold of 1 snaps it; the JS default would round to 0 and animate.
    observe(cursor(1, 0));
    stepTo(0);
    observe(cursor(1 - 0.5, 0));
    stepTo(50);
    assert.deepEqual(cornerX(), [0.1875, 0.1875, 0.0625, 0.0625]);
    assert.isFalse((model as any)._needsRender, 'half-cell move snaps at threshold 1');
  }
});
