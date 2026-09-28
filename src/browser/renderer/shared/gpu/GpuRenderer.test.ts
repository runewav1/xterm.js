/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { Terminal } from '../../../public/Terminal';
import { MockCharacterJoinerService, MockCharSizeService, MockThemeService } from '../../../TestUtils.test';
import { MockCoreService, MockDecorationService, MockLogService, MockOptionsService } from '../../../../common/TestUtils.test';
import { Emitter } from '../../../../common/Event';
import { DisposableStore } from '../../../../common/Lifecycle';
import { css } from '../../../../common/Color';
import type { ICoreBrowserService } from '../../../services/Services';
import type { IRenderDimensions } from '../Types';
import type { IGpuBackend, IGlyphRenderer, IRectangleRenderer, IRenderModel, ICursorTrailVertices } from './Types';
import { GpuRenderer } from './GpuRenderer';

class FakeGlyphRenderer implements IGlyphRenderer {
  public beginFrameCalls = 0;
  public clearCalls = 0;
  public invalidateAtlasTexturesCalls = 0;
  public renderCalls = 0;
  public beginFrameResults: boolean[] = [];
  public beginFrame(): boolean {
    this.beginFrameCalls++;
    return this.beginFrameResults.shift() ?? false;
  }
  public updatedCells: { x: number, y: number, code: number, chars: string }[] = [];
  public copyRowsCalls: { src: number, dest: number, count: number }[] = [];
  public updateCell(x: number, y: number, code: number, _bg: number, _fg: number, _ext: number, chars: string): void {
    this.updatedCells.push({ x, y, code, chars });
  }
  public copyRows(src: number, dest: number, count: number): void {
    this.copyRowsCalls.push({ src, dest, count });
  }
  public clear(): void { this.clearCalls++; }
  public handleResize(): void {}
  public render(): void { this.renderCalls++; }
  public setAtlas(): void {}
  public invalidateAtlasTextures(): void { this.invalidateAtlasTexturesCalls++; }
  public setDimensions(): void {}
  public dispose(): void {}
}

class FakeRectangleRenderer implements IRectangleRenderer {
  public updateBackgroundsCalls: { startRow: number, endRow: number }[] = [];
  public updateBackgrounds(_model: IRenderModel, startRow: number, endRow: number): void {
    this.updateBackgroundsCalls.push({ startRow, endRow });
  }
  public trailFrames: ICursorTrailVertices[] = [];
  public updateCursor(): void {}
  public renderBackgrounds(): void {}
  public renderCursor(): void {}
  public renderCursorTrail(vertices: ICursorTrailVertices): void { this.trailFrames.push(vertices); }
  public handleResize(): void {}
  public setDimensions(): void {}
  public dispose(): void {}
}

class FakeBackend implements IGpuBackend {
  public readonly maxTextureSize = 8192;
  public readonly maxAtlasPages = 16;
  public readonly onContextLoss = new Emitter<void>().event;
  public beginRenderCalls = 0;
  constructor(private readonly _glyphRenderer: IGlyphRenderer, private readonly _rectangleRenderer: IRectangleRenderer) {}
  public createRenderers(): { glyphRenderer: IGlyphRenderer, rectangleRenderer: IRectangleRenderer } {
    return { glyphRenderer: this._glyphRenderer, rectangleRenderer: this._rectangleRenderer };
  }
  public beginRender(_dimensions: IRenderDimensions): void { this.beginRenderCalls++; }
  public endRender(): void {}
  public dispose(): void {}
}

function createFakeWindow(): Window & typeof globalThis {
  return {
    ResizeObserver: class {
      public observe(): void {}
      public disconnect(): void {}
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {}
  } as unknown as Window & typeof globalThis;
}

function createFakeCanvas(): HTMLCanvasElement {
  return {
    classList: { add: () => {} },
    style: {},
    width: 0,
    height: 0,
    getContext: (type: string) => type === '2d' ? { fillStyle: '', fillRect: () => {}, clearRect: () => {} } : null,
    appendChild: () => {},
    remove: () => {},
    addEventListener: () => {}
  } as unknown as HTMLCanvasElement;
}

function createFakeDocument(): Document {
  return {
    createElement: () => createFakeCanvas(),
    addEventListener: () => {},
    removeEventListener: () => {}
  } as unknown as Document;
}

function createCoreBrowserService(): { service: ICoreBrowserService, state: { isFocused: boolean } } {
  const state = { isFocused: true };
  const service = {
    serviceBrand: undefined,
    get isFocused(): boolean { return state.isFocused; },
    dpr: 1,
    onDprChange: new Emitter<number>().event,
    onWindowChange: new Emitter<Window & typeof globalThis>().event,
    window: createFakeWindow(),
    mainDocument: createFakeDocument()
  } as unknown as ICoreBrowserService;
  return { service, state };
}

describe('GpuRenderer', () => {
  let store: DisposableStore;
  let terminal: Terminal;
  let renderer: GpuRenderer;
  let coreBrowserService: ICoreBrowserService;
  let coreBrowserState: { isFocused: boolean };
  let coreService: MockCoreService;
  let glyphRenderer: FakeGlyphRenderer;
  let rectangleRenderer: FakeRectangleRenderer;
  let backend: FakeBackend;

  beforeEach(() => {
    store = new DisposableStore();
    terminal = new Terminal({ cols: 2, rows: 2 });
    const core = (terminal as any)._core;
    core.screenElement = { appendChild: () => {}, isConnected: false, style: {} };
    const noopDisposable = () => ({ dispose: () => {} });
    core._linkifier.value = {
      onShowLinkUnderline: noopDisposable,
      onHideLinkUnderline: noopDisposable
    };
    const coreBrowser = createCoreBrowserService();
    coreBrowserService = coreBrowser.service;
    coreBrowserState = coreBrowser.state;
    coreService = new MockCoreService();
    glyphRenderer = new FakeGlyphRenderer();
    rectangleRenderer = new FakeRectangleRenderer();
    backend = new FakeBackend(glyphRenderer, rectangleRenderer);
    const theme = new MockThemeService();
    theme.colors = { ...theme.colors, cursor: css.toColor('#ffffff'), cursorAccent: css.toColor('#000000') };
    renderer = store.add(new GpuRenderer(
      terminal,
      new MockCharacterJoinerService(),
      new MockCharSizeService(0, 0),
      coreBrowserService,
      coreService,
      new MockDecorationService(),
      new MockLogService(),
      new MockOptionsService(),
      theme,
      true,
      () => backend
    ));
  });

  afterEach(() => store.dispose());

  function updateModel(start: number, end: number): void {
    (renderer as any)._updateModel(start, end);
  }

  function clearModel(clearGlyphRenderer: boolean): void {
    (renderer as any)._clearModel(clearGlyphRenderer);
  }

  function writeSync(data: string): Promise<void> {
    return new Promise<void>(r => terminal.write(data, () => r()));
  }

  it('forces a full background rebuild after clear even when the terminal is entirely default', () => {
    // Consume the forced background update from the constructor resize. An
    // all-default terminal compares equal to the cleared model, so without the
    // forced flag the stale rectangle caches would survive.
    updateModel(0, terminal.rows - 1);
    const callsBefore = rectangleRenderer.updateBackgroundsCalls.length;
    assert.ok(callsBefore > 0);
    clearModel(true);
    updateModel(0, terminal.rows - 1);
    assert.strictEqual(rectangleRenderer.updateBackgroundsCalls.length, callsBefore + 1);
    const lastCall = rectangleRenderer.updateBackgroundsCalls[rectangleRenderer.updateBackgroundsCalls.length - 1];
    assert.deepStrictEqual([lastCall.startRow, lastCall.endRow], [0, terminal.rows - 1]);
  });

  it('rebuilds the whole viewport background on resize', () => {
    updateModel(0, terminal.rows - 1);
    const callsBefore = rectangleRenderer.updateBackgroundsCalls.length;
    renderer.handleResize(2, 2);
    updateModel(0, terminal.rows - 1);
    assert.strictEqual(rectangleRenderer.updateBackgroundsCalls.length, callsBefore + 1);
    const lastCall = rectangleRenderer.updateBackgroundsCalls[rectangleRenderer.updateBackgroundsCalls.length - 1];
    assert.deepStrictEqual([lastCall.startRow, lastCall.endRow], [0, terminal.rows - 1]);
  });

  it('skips background updates for foreground-only changes', async () => {
    terminal.options.cursorStyle = 'bar';
    updateModel(0, terminal.rows - 1);
    const callsBefore = rectangleRenderer.updateBackgroundsCalls.length;
    await writeSync('X');
    updateModel(0, 0);
    assert.strictEqual(rectangleRenderer.updateBackgroundsCalls.length, callsBefore);
  });

  it('updates backgrounds when the background color of a cell changes', async () => {
    terminal.options.cursorStyle = 'bar';
    updateModel(0, terminal.rows - 1);
    const callsBefore = rectangleRenderer.updateBackgroundsCalls.length;
    await writeSync('\x1b[41mX');
    updateModel(0, 0);
    assert.ok(rectangleRenderer.updateBackgroundsCalls.length > callsBefore);
    const lastCall = rectangleRenderer.updateBackgroundsCalls[rectangleRenderer.updateBackgroundsCalls.length - 1];
    assert.deepStrictEqual([lastCall.startRow, lastCall.endRow], [0, 0]);
  });

  describe('shifted row reuse', () => {
    const COLS = 6;
    const ROWS = 5;

    beforeEach(() => {
      terminal.resize(COLS, ROWS);
      renderer.handleResize(COLS, ROWS);
      coreService.isCursorHidden = true;
    });

    function modelSnapshot(): number[] {
      return Array.from((renderer as any)._model.cells as Uint32Array);
    }

    function fullRebuildSnapshot(): number[] {
      clearModel(true);
      updateModel(0, ROWS - 1);
      return modelSnapshot();
    }

    it('moves rows after a scroll and only updates the newly exposed row', async () => {
      await writeSync('\x1b[31maaaa\r\n\x1b[32mbbbb\r\n\x1b[33mcccc\r\n\x1b[34mdddd\r\n\x1b[35meeee');
      updateModel(0, ROWS - 1);
      glyphRenderer.updatedCells.length = 0;

      await writeSync('\r\n\x1b[36mffff');
      updateModel(0, ROWS - 1);

      assert.deepStrictEqual(glyphRenderer.copyRowsCalls, [{ src: 1, dest: 0, count: ROWS - 1 }]);
      assert.ok(glyphRenderer.updatedCells.length > 0);
      assert.ok(glyphRenderer.updatedCells.every(c => c.y === ROWS - 1), 'only the new row is rebuilt');
      const reused = modelSnapshot();
      assert.deepStrictEqual(reused, fullRebuildSnapshot());
    });

    it('moves rows downwards for a reverse scroll inside a scroll region', async () => {
      await writeSync('\x1b[31maaaa\r\n\x1b[32mbbbb\r\n\x1b[33mcccc\r\n\x1b[34mdddd\r\n\x1b[35meeee');
      updateModel(0, ROWS - 1);
      glyphRenderer.updatedCells.length = 0;

      // Region rows 2-4 (1-based), scroll down one line.
      await writeSync('\x1b[2;4r\x1b[T');
      updateModel(1, 3);

      assert.deepStrictEqual(glyphRenderer.copyRowsCalls, [{ src: 1, dest: 2, count: 2 }]);
      assert.ok(glyphRenderer.updatedCells.every(c => c.y === 1), 'only the blank inserted row is rebuilt');
      const reused = modelSnapshot();
      assert.deepStrictEqual(reused, fullRebuildSnapshot());
    });

    it('stays correct when a moved line was also modified', async () => {
      await writeSync('aaaa\r\nbbbb\r\ncccc\r\ndddd\r\neeee');
      updateModel(0, ROWS - 1);

      await writeSync('\r\nffff\x1b[2;1H\x1b[41mXY');
      updateModel(0, ROWS - 1);

      assert.strictEqual(glyphRenderer.copyRowsCalls.length, 1);
      const reused = modelSnapshot();
      assert.deepStrictEqual(reused, fullRebuildSnapshot());
    });

    it('rebuilds backgrounds for moved rows', async () => {
      await writeSync('\x1b[41maaaa\x1b[0m\r\nbbbb\r\ncccc\r\ndddd\r\neeee');
      updateModel(0, ROWS - 1);
      const callsBefore = rectangleRenderer.updateBackgroundsCalls.length;

      await writeSync('\r\nffff');
      updateModel(0, ROWS - 1);

      assert.strictEqual(rectangleRenderer.updateBackgroundsCalls.length, callsBefore + 1);
    });

    it('does not reuse rows after the model is cleared', async () => {
      await writeSync('aaaa\r\nbbbb\r\ncccc\r\ndddd\r\neeee');
      updateModel(0, ROWS - 1);
      clearModel(true);
      await writeSync('\r\nffff');
      updateModel(0, ROWS - 1);
      assert.strictEqual(glyphRenderer.copyRowsCalls.length, 0);
    });
  });

  it('skips unchanged astral cells but always updates combined cells', async () => {
    terminal.options.cursorStyle = 'bar';
    await writeSync('\u{1F600}');
    updateModel(0, 0);
    glyphRenderer.updatedCells.length = 0;
    updateModel(0, 0);
    assert.strictEqual(glyphRenderer.updatedCells.filter(c => c.chars === '\u{1F600}').length, 0);

    await writeSync('\r\x1b[Ke\u0301');
    updateModel(0, 0);
    glyphRenderer.updatedCells.length = 0;
    updateModel(0, 0);
    // A combined cell's code is only its last codepoint, so it cannot prove the
    // string is unchanged.
    assert.strictEqual(glyphRenderer.updatedCells.filter(c => c.chars === 'e\u0301').length, 1);
  });

  it('preserves the cursor model when refreshing rows that do not contain the cursor', () => {
    terminal.options.cursorStyle = 'bar';
    updateModel(terminal.rows - 1, terminal.rows - 1);
    const cursor = (renderer as any)._model.cursor;
    assert.ok(cursor, 'cursor must survive an unrelated row refresh');
    assert.strictEqual(cursor.style, 'bar');
    assert.strictEqual(cursor.y, 0);
  });

  it('uses the inactive cursor style when the terminal is not focused', () => {
    coreBrowserState.isFocused = false;
    terminal.options.cursorStyle = 'bar';
    updateModel(0, 0);
    const cursor = (renderer as any)._model.cursor;
    assert.ok(cursor);
    assert.strictEqual(cursor.style, 'outline');
  });

  it('clears the cursor model when the cursor is hidden', () => {
    terminal.options.cursorStyle = 'bar';
    updateModel(0, terminal.rows - 1);
    assert.ok((renderer as any)._model.cursor);
    coreService.isCursorHidden = true;
    updateModel(0, terminal.rows - 1);
    assert.strictEqual((renderer as any)._model.cursor, undefined);
  });

  it('clears the cursor model when the cursor is scrolled outside the viewport', () => {
    terminal.options.cursorStyle = 'bar';
    updateModel(0, terminal.rows - 1);
    assert.ok((renderer as any)._model.cursor);
    (terminal as any)._core.buffer.ydisp = 10;
    updateModel(0, terminal.rows - 1);
    assert.strictEqual((renderer as any)._model.cursor, undefined);
  });

  it('defers rendering without consuming an atlas invalidation at the merge retry limit', () => {
    // Initial invalidation plus 32 invalidations caused by consecutive model
    // rebuilds reaches the retry limit. One more pending invalidation must be
    // left for the next frame instead of being acknowledged and ignored.
    (renderer as any)._isAttached = true;
    (renderer as any)._charAtlas = {};
    glyphRenderer.beginFrameResults = new Array(34).fill(true);
    let redraws = 0;
    store.add(renderer.onRequestRedraw(() => redraws++));

    renderer.renderRows(0, terminal.rows - 1);

    assert.strictEqual(glyphRenderer.beginFrameCalls, 33);
    assert.strictEqual(glyphRenderer.beginFrameResults.length, 1);
    assert.strictEqual(glyphRenderer.invalidateAtlasTexturesCalls, 1);
    assert.strictEqual(backend.beginRenderCalls, 0);
    assert.strictEqual(glyphRenderer.renderCalls, 0);
    assert.strictEqual(redraws, 1);

    renderer.renderRows(0, terminal.rows - 1);

    assert.strictEqual(glyphRenderer.beginFrameResults.length, 0);
    assert.strictEqual(backend.beginRenderCalls, 1);
    assert.strictEqual(glyphRenderer.renderCalls, 1);
  });

  it('rejects CSS-pixel ResizeObserver dimensions reported as device pixels', () => {
    renderer.dimensions.css.canvas.width = 107;
    renderer.dimensions.css.canvas.height = 32;
    renderer.dimensions.device.canvas.width = 160;
    renderer.dimensions.device.canvas.height = 48;
    const canvas = (renderer as any)._canvas as HTMLCanvasElement;

    (renderer as any)._setCanvasDevicePixelDimensions(107, 32);

    assert.deepStrictEqual([canvas.width, canvas.height], [160, 48]);
  });

  it('accepts genuine device-pixel ResizeObserver rounding corrections', () => {
    renderer.dimensions.css.canvas.width = 107;
    renderer.dimensions.css.canvas.height = 32;
    renderer.dimensions.device.canvas.width = 160;
    renderer.dimensions.device.canvas.height = 48;
    const canvas = (renderer as any)._canvas as HTMLCanvasElement;

    (renderer as any)._setCanvasDevicePixelDimensions(159, 47);

    assert.deepStrictEqual([canvas.width, canvas.height], [159, 47]);
  });

  it('draws trail vertices during renderRows, including the empty disabled case', () => {
    (renderer as any)._isAttached = true;
    renderer.renderRows(0, terminal.rows - 1);
    assert.strictEqual(rectangleRenderer.trailFrames.length, 1);
    assert.strictEqual(rectangleRenderer.trailFrames[0].visible, false);
  });

  it('resets the trail on clear, viewport hide, scroll and resize but not on blur', () => {
    const trail = (renderer as any)._cursorTrail;
    renderer.dimensions.device.cell.width = 10;
    renderer.dimensions.device.cell.height = 20;
    renderer.dimensions.device.canvas.width = 20;
    renderer.dimensions.device.canvas.height = 40;
    coreService.cursorPositionChangedAt = -100000;
    trail.setOptions({ cursorTrail: 20 });
    const seed = (): void => {
      (trail as any)._cursor = { x: 0, y: 0, width: 1, style: 'block', cursorWidth: 1, dpr: 1 };
      (trail as any)._advance(0);
      (trail as any)._cursor = { x: 1, y: 0, width: 1, style: 'block', cursorWidth: 1, dpr: 1 };
      (trail as any)._advance(100);
      assert.ok((trail as any)._hasGeometry, 'trail should track a cursor');
    };

    seed();
    renderer.clear();
    assert.ok(!(trail as any)._hasGeometry);

    seed();
    renderer.handleBlur();
    // kitty keeps animating the active pane while the OS window is unfocused.
    assert.ok((trail as any)._hasGeometry, 'blur must not reset trail motion');

    seed();
    renderer.handleViewportVisibilityChange(false);
    assert.ok(!(trail as any)._hasGeometry);

    renderer.handleViewportVisibilityChange(true);
    seed();
    (terminal as any)._core.buffer.ydisp = 5;
    (renderer as any)._updateModel(0, terminal.rows - 1);
    assert.ok(!(trail as any)._hasGeometry, 'scrolling drops the in-flight trail');

    (terminal as any)._core.buffer.ydisp = 0;
    (renderer as any)._updateModel(0, terminal.rows - 1);
    seed();
    renderer.handleResize(terminal.cols, terminal.rows);
    assert.ok(!(trail as any)._hasGeometry);
  });

  it('gates retargeting while the viewport is hidden and re-establishes on return', () => {
    renderer.dimensions.device.cell.width = 10;
    renderer.dimensions.device.cell.height = 20;
    renderer.dimensions.device.canvas.width = 20;
    renderer.dimensions.device.canvas.height = 40;
    coreService.cursorPositionChangedAt = -100000;
    const trail = (renderer as any)._cursorTrail;
    trail.setOptions({ cursorTrail: 1000 });

    renderer.handleViewportVisibilityChange(true);
    (renderer as any)._updateModel(0, terminal.rows - 1);
    assert.ok((renderer as any)._trailCursor, 'visible viewport exposes cursor geometry');
    (trail as any)._advance(0);
    assert.ok((trail as any)._hasGeometry, 'trail establishes geometry');

    renderer.handleViewportVisibilityChange(false);
    assert.ok(!(trail as any)._hasGeometry, 'hidden viewport hard clears the trail');
    (renderer as any)._updateModel(0, terminal.rows - 1);
    assert.ok(!(renderer as any)._trailCursor, 'hidden viewport gates retargeting');
  });
});
