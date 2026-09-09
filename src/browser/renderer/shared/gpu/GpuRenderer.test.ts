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
import type { IGpuBackend, IGlyphRenderer, IRectangleRenderer, IRenderModel } from './Types';
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
  public updateCell(): void {}
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
  public updateCursor(): void {}
  public renderBackgrounds(): void {}
  public renderCursor(): void {}
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
});
