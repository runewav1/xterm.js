/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { DisposableStore } from '../../../../common/Lifecycle';
import { Emitter } from '../../../../common/Event';
import { css } from '../../../../common/Color';
import type { ICoreBrowserService, IThemeService } from '../../../services/Services';
import type { IRenderDimensions } from '../Types';
import type { ICursorRenderModel } from './Types';
import { CursorSmearModel } from './CursorSmearModel';

class FakeWindow {
  public time = 0;
  public reducedMotion = false;
  public canceled = 0;
  public readonly rafCallbacks = new Map<number, FrameRequestCallback>();
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

  public flush(): void {
    const callbacks = Array.from(this.rafCallbacks.values());
    this.rafCallbacks.clear();
    for (const callback of callbacks) {
      callback(0);
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

  public setWindow(window: FakeWindow): void {
    this._window = window as unknown as Window & typeof globalThis;
    this.windowChange.fire(this._window);
  }
}

function createThemeService(): IThemeService & { themeChanges: Emitter<IThemeService['colors']> } {
  const themeChanges = new Emitter<IThemeService['colors']>();
  return {
    serviceBrand: undefined,
    onChangeColors: themeChanges.event,
    themeChanges,
    colors: { cursor: css.toColor('#ffffff') },
    restoreColor: () => {},
    modifyColors: () => {}
  } as unknown as IThemeService & { themeChanges: Emitter<IThemeService['colors']> };
}

const CELL_WIDTH = 10;
const CELL_HEIGHT = 20;
const COLS = 8;
const ROWS = 4;

function createDimensions(): IRenderDimensions {
  return {
    css: { canvas: { width: COLS * CELL_WIDTH, height: ROWS * CELL_HEIGHT }, cell: { width: CELL_WIDTH, height: CELL_HEIGHT } },
    device: {
      canvas: { width: COLS * CELL_WIDTH, height: ROWS * CELL_HEIGHT },
      cell: { width: CELL_WIDTH, height: CELL_HEIGHT },
      char: { width: CELL_WIDTH, height: CELL_HEIGHT, left: 0, top: 0 }
    }
  };
}

function cursor(x: number, y: number, style: ICursorRenderModel['style'] = 'bar', width = 1): ICursorRenderModel {
  return { x, y, width, style, cursorWidth: 1, dpr: 1 };
}

describe('CursorSmearModel', () => {
  let store: DisposableStore;
  let window: FakeWindow;
  let coreBrowser: FakeCoreBrowserService;
  let theme: ReturnType<typeof createThemeService>;
  let model: CursorSmearModel;
  let renderRequests: number;

  function createModel(target: FakeWindow = window, browser: FakeCoreBrowserService = coreBrowser): CursorSmearModel {
    return store.add(new CursorSmearModel(
      createDimensions(),
      browser as unknown as ICoreBrowserService,
      theme,
      () => renderRequests++
    ));
  }

  beforeEach(() => {
    store = new DisposableStore();
    window = new FakeWindow();
    coreBrowser = new FakeCoreBrowserService(window);
    theme = createThemeService();
    renderRequests = 0;
    model = createModel();
  });

  afterEach(() => store.dispose());

  it('stays fully idle when disabled', () => {
    model.setOptions(undefined);
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);
  });

  it('does not create a phantom trail on the first observation', () => {
    model.setOptions({ enabled: true });
    model.setCursor(cursor(0, 0));
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);
  });

  it('grows a trail after a move and clears once finished', () => {
    model.setOptions({ enabled: true, duration: 100, samples: 4 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.isAbove(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 1);

    window.time = 50;
    window.flush();
    assert.isAbove(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 1);

    window.time = 100;
    window.flush();
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);
  });

  it('emits a single ghost for the fade style', () => {
    model.setOptions({ enabled: true, style: 'fade', samples: 8 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.strictEqual(model.vertices.count, 1);
  });

  it('reuses the vertex buffer across frames', () => {
    model.setOptions({ enabled: true, duration: 200 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    const attributes = model.vertices.attributes;
    window.time = 50;
    window.flush();
    window.time = 100;
    window.flush();
    assert.strictEqual(model.vertices.attributes, attributes);
  });

  it('continues from the in-flight position on rapid retargets', () => {
    model.setOptions({ enabled: true, duration: 200, samples: 4 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    window.time = 90;
    window.flush();
    model.setCursor(cursor(8, 0));
    const source = (model as any)._source as { x: number };
    assert.isAbove(source.x, 2);
    assert.isBelow(source.x, 4);
  });

  it('honors minDistance', () => {
    model.setOptions({ enabled: true, minDistance: 3 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(1, 0));
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);
    model.setCursor(cursor(4, 0));
    assert.isAbove(model.vertices.count, 0);
  });

  it('resets without smearing when maxDistance is exceeded', () => {
    model.setOptions({ enabled: true, maxDistance: 2 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(6, 0));
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);
  });

  it('multiplies the color alpha into the emitted opacity', () => {
    model.setOptions({ enabled: true, style: 'fade', color: '#ff000080' });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.approximately(model.vertices.attributes[7], 0.5 * (128 / 255), 0.01);
  });

  it('does not schedule or emit when duration is zero and keeps a fresh baseline', () => {
    model.setOptions({ enabled: true, duration: 0 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);
    assert.strictEqual((model as any)._head.x, 4);

    model.setOptions({ enabled: true, duration: 100 });
    model.setCursor(cursor(8, 0));
    assert.isAbove(model.vertices.count, 0);
  });

  it('does not schedule or emit when opacity is zero', () => {
    model.setOptions({ enabled: true, opacity: 0 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);
  });

  it('does not schedule or emit for a fully transparent color', () => {
    model.setOptions({ enabled: true, color: '#ff000000' });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);
  });

  it('retains the cursor baseline after completion so the next move smears', () => {
    model.setOptions({ enabled: true, duration: 100 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    window.time = 100;
    window.flush();
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual((model as any)._source, (model as any)._head);

    model.setCursor(cursor(8, 0));
    assert.isAbove(model.vertices.count, 0);
  });

  it('retargets fade mode from the visible ghost instead of the invisible head', () => {
    model.setOptions({ enabled: true, style: 'fade', duration: 1000 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    window.time = 100;
    window.flush();
    model.setCursor(cursor(8, 0));
    assert.strictEqual((model as any)._source.x, 0);
  });

  it('clears an in-flight trail on an ignored movement and re-baselines', () => {
    model.setOptions({ enabled: true, duration: 1000, minDistance: 3 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.isAbove(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 1);

    model.setCursor(cursor(5, 0));
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);
    assert.strictEqual((model as any)._head.x, 5);
  });

  it('clears an in-flight trail on a shape-only change', () => {
    model.setOptions({ enabled: true, duration: 1000, minDistance: 0 });
    model.setCursor(cursor(0, 0, 'bar'));
    model.setCursor(cursor(4, 0, 'bar'));
    assert.isAbove(model.vertices.count, 0);

    model.setCursor(cursor(4, 0, 'underline'));
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);
  });

  it('cancels a pending frame on the window that scheduled it', () => {
    const windowB = new FakeWindow();
    model.setOptions({ enabled: true, duration: 1000 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.strictEqual(window.rafCallbacks.size, 1);

    coreBrowser.setWindow(windowB);
    assert.strictEqual(window.canceled, 1);
    assert.strictEqual(windowB.canceled, 0);

    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.strictEqual(windowB.rafCallbacks.size, 1);
  });

  it('rebuilds active vertices immediately on theme change', () => {
    model.setOptions({ enabled: true, style: 'fade', duration: 1000 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.approximately(model.vertices.attributes[4], 1, 0.01);
    assert.approximately(model.vertices.attributes[5], 1, 0.01);

    (theme as any).colors = { cursor: css.toColor('#ff0000') };
    theme.themeChanges.fire((theme as any).colors);
    assert.approximately(model.vertices.attributes[4], 1, 0.01);
    assert.approximately(model.vertices.attributes[5], 0, 0.01);
  });

  it('rebuilds active vertices immediately on an option change', () => {
    model.setOptions({ enabled: true, style: 'fade', duration: 1000, opacity: 0.5 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.approximately(model.vertices.attributes[7], 0.5, 0.01);

    model.setOptions({ enabled: true, style: 'fade', duration: 1000, opacity: 0.2 });
    assert.approximately(model.vertices.attributes[7], 0.2, 0.01);
  });

  it('clips smear geometry out of the live block cursor cell', () => {
    model.setOptions({ enabled: true, style: 'trail', duration: 1000, samples: 16, easing: 'linear' });
    model.setCursor(cursor(0, 0, 'block'));
    model.setCursor(cursor(1, 0, 'block'));
    window.time = 700;
    window.flush();
    // The destination cell (x=1) must not receive any smear rectangle.
    const attributes = model.vertices.attributes;
    const cellW = CELL_WIDTH;
    const canvasW = COLS * CELL_WIDTH;
    const cellH = CELL_HEIGHT;
    const canvasH = ROWS * CELL_HEIGHT;
    const exL = 1 * cellW / canvasW;
    const exR = 2 * cellW / canvasW;
    const exT = 0;
    const exB = 1 * cellH / canvasH;
    for (let i = 0; i < model.vertices.count; i++) {
      const offset = i * 8;
      const x0 = attributes[offset];
      const x1 = x0 + attributes[offset + 2];
      const y0 = attributes[offset + 1];
      const y1 = y0 + attributes[offset + 3];
      // Reconstructed edges come from float32 storage, so allow a sub-pixel
      // epsilon before treating a ghost as meaningfully overlapping.
      const overlapX = Math.min(x1, exR) - Math.max(x0, exL);
      const overlapY = Math.min(y1, exB) - Math.max(y0, exT);
      const overlaps = overlapX > 1e-5 && overlapY > 1e-5;
      assert.isFalse(overlaps, `ghost ${i} overlaps the live block cursor cell: [${x0},${x1}]x[${y0},${y1}] vs [${exL},${exR}]x[${exT},${exB}] count=${model.vertices.count}`);
    }
  });

  it('honors the reduced motion preference and reacts to changes', () => {
    window.setReducedMotion(true);
    model.setOptions({ enabled: true });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);

    window.setReducedMotion(false);
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.isAbove(model.vertices.count, 0);
  });

  it('can opt out of reduced motion', () => {
    window.reducedMotion = true;
    model.setOptions({ enabled: true, respectReducedMotion: false });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.isAbove(model.vertices.count, 0);
  });

  it('hard clears while the cursor is hidden and cancels the frame', () => {
    model.setOptions({ enabled: true, duration: 200 });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    const version = model.vertices.version;
    model.setCursor(undefined);
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);
    assert.isAbove(model.vertices.version, version);
  });

  it('clears on resize', () => {
    model.setOptions({ enabled: true });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    model.setDimensions(createDimensions());
    assert.strictEqual(model.vertices.count, 0);
    assert.strictEqual(window.rafCallbacks.size, 0);
  });

  it('uses the theme cursor color by default and the override when set', () => {
    (theme as any).colors = { cursor: css.toColor('#00ff00') };
    model = createModel();
    model.setOptions({ enabled: true, style: 'fade' });
    model.setCursor(cursor(0, 0));
    model.setCursor(cursor(4, 0));
    assert.approximately(model.vertices.attributes[4], 0, 0.01);
    assert.approximately(model.vertices.attributes[5], 1, 0.01);

    model.setOptions({ enabled: true, style: 'fade', color: '#ff0000' });
    assert.approximately(model.vertices.attributes[4], 1, 0.01);
    assert.approximately(model.vertices.attributes[5], 0, 0.01);
  });

  it('tapers the oldest ghost using endScale', () => {
    model.setOptions({ enabled: true, samples: 4, endScale: 0.5 });
    model.setCursor(cursor(0, 0, 'block'));
    model.setCursor(cursor(4, 0, 'block'));
    // First emitted rectangle is the oldest ghost (frac 0) with scale 0.5.
    assert.approximately(model.vertices.attributes[2], (CELL_WIDTH * 0.5) / (COLS * CELL_WIDTH), 0.0001);
  });

  it('preserves wide cell widths', () => {
    model.setOptions({ enabled: true, style: 'fade' });
    model.setCursor(cursor(0, 0, 'block', 2));
    model.setCursor(cursor(4, 0, 'block', 2));
    assert.approximately(model.vertices.attributes[2], (2 * CELL_WIDTH) / (COLS * CELL_WIDTH), 0.0001);
  });
});
