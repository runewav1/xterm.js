/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { decodePng } from '@lunapaint/png-codec';
import test, { expect } from '@playwright/test';
import { openTerminal } from '../../../test/playwright/TestUtils';
import { IWebgpuTestContext, assertWebgpuEvents, assertWebgpuRenderer, createWebgpuAddon, createWebgpuTestContext, loadWebgpuAddon, waitForWebgpuRender } from './WebgpuTestUtils';

test.describe('WebGPU lifecycle and device validation', () => {
  let ctx: IWebgpuTestContext;
  let expectedErrors: number;
  let expectedLosses: number;
  let expectedSynchronousErrors: number;

  test.beforeEach(async ({ browser }) => {
    ctx = await createWebgpuTestContext(browser);
    expectedErrors = 0;
    expectedLosses = 0;
    expectedSynchronousErrors = 0;
  });

  test.afterEach(async () => {
    if (ctx) {
      try {
        await ctx.page.evaluate('window.term?.dispose(); window.termB?.dispose(); window.addon?.dispose(); window.oldAddon?.dispose(); window.session?.dispose()');
        await assertWebgpuEvents(ctx, expectedErrors, expectedLosses, expectedSynchronousErrors);
      } finally {
        await ctx.page.close();
      }
    }
  });

  test('disposal before open cancels deferred activation', async () => {
    await ctx.page.evaluate('window.term = new window.Terminal({ allowProposedApi: true })');
    await createWebgpuAddon(ctx);
    await ctx.page.evaluate(`(async () => {
      window.term.loadAddon(window.addon);
      window.addon.dispose();
      window.addon.dispose();
      await window.addon._device.lost;
      window.term.open(document.querySelector('#terminal-container'));
      await new Promise(resolve => window.term.write('disposed before open', resolve));
    })()`);
    expect(await ctx.page.evaluate('window.term._core._renderService._renderer.value.constructor.name')).toBe('DomRenderer');
    await expect(ctx.page.locator('.xterm-rows')).toContainText('disposed before open');
    await expect(ctx.page.locator('.xterm-screen canvas')).toHaveCount(0);
  });

  test('activation before open installs WebGPU synchronously when opened', async () => {
    await ctx.page.evaluate('window.term = new window.Terminal({ allowProposedApi: true })');
    await createWebgpuAddon(ctx);
    await ctx.page.evaluate(`
      window.term.loadAddon(window.addon);
      window.term.open(document.querySelector('#terminal-container'));
    `);
    await assertWebgpuRenderer(ctx);
    await waitForWebgpuRender(ctx);
  });

  for (const failure of ['loss', 'error'] as const) {
    test(`WebGPU ${failure} before open does not interrupt deferred WebGL activation`, async () => {
      await ctx.page.evaluate('window.term = new window.Terminal({ allowProposedApi: true })');
      await createWebgpuAddon(ctx);
      await ctx.page.evaluate(`
        window.term.loadAddon(window.addon);
        window.webgl = new window.WebglAddon();
        window.term.loadAddon(window.webgl);
      `);
      if (failure === 'loss') {
        expectedLosses = 1;
        await ctx.page.evaluate('window.addon._device.destroy()');
        await expect.poll(() => ctx.page.evaluate('window.gpuEvents.losses')).toBe(1);
      } else {
        expectedErrors = 1;
        await ctx.page.evaluate(`(async () => {
          window.addon._device.createBuffer({ size: 4, usage: 0 });
          await window.addon._device.queue.onSubmittedWorkDone();
        })()`);
        await expect.poll(() => ctx.page.evaluate('window.gpuEvents.errors.length')).toBe(1);
      }
      await ctx.page.evaluate(`(async () => {
        window.term.open(document.querySelector('#terminal-container'));
        await new Promise(resolve => window.term.write('WebGL after pre-open failure', resolve));
        await new Promise(resolve => {
          const listener = window.term.onRender(() => { listener.dispose(); resolve(); });
          window.term.refresh(0, window.term.rows - 1);
        });
      })()`);
      expect(await ctx.page.evaluate(`(() => {
        const renderer = window.term._core._renderService._renderer.value;
        return {
          ownedByWebgl: renderer === window.webgl._renderer,
          connected: renderer._canvas?.isConnected === true,
          webgl: renderer._canvas?.getContext('webgl2') instanceof WebGL2RenderingContext,
          gpuNeverActivated: window.addon._renderer === undefined
        };
      })()`)).toEqual({ ownedByWebgl: true, connected: true, webgl: true, gpuNeverActivated: true });
      await ctx.page.locator('.xterm-screen').screenshot();
    });
  }

  for (const customGlyphs of [true, false]) {
    test(`WebGPU replacement preserves atlas ownership (customGlyphs=true -> ${customGlyphs})`, async () => {
      await openTerminal(ctx, { cols: 20, rows: 2 });
      await loadWebgpuAddon(ctx);
      await waitForWebgpuRender(ctx);
      await ctx.page.evaluate(`
        window.oldAddon = window.addon;
        window.oldAtlas = window.addon._renderer._charAtlas;
        window.oldAtlasDisposals = 0;
        window.prematureAtlasDisposal = false;
        const dispose = window.oldAtlas.dispose;
        window.oldAtlas.dispose = function () {
          window.oldAtlasDisposals++;
          window.prematureAtlasDisposal ||= !window.oldAddon._renderer.isDisposed;
          return dispose.call(this);
        };
      `);
      await loadWebgpuAddon(ctx, customGlyphs);
      expect(await ctx.page.evaluate(`({
        reused: window.addon._renderer._charAtlas === window.oldAtlas,
        disposals: window.oldAtlasDisposals,
        premature: window.prematureAtlasDisposal,
        oldRendererDisposed: window.oldAddon._renderer.isDisposed,
        oldCanvasConnected: window.oldAddon._renderer._canvas.isConnected
      })`)).toEqual({ reused: customGlyphs, disposals: customGlyphs ? 0 : 1, premature: false, oldRendererDisposed: true, oldCanvasConnected: false });
      await ctx.page.evaluate(`
        window.replacementAtlasDisposals = 0;
        const atlas = window.addon._renderer._charAtlas;
        const dispose = atlas.dispose;
        atlas.dispose = function () {
          window.replacementAtlasDisposals++;
          return dispose.call(this);
        };
        window.oldAddon.dispose();
        window.addon.clearTextureAtlas();
      `);
      await ctx.proxy.write('GPU replacement');
      await waitForWebgpuRender(ctx);
      await assertWebgpuRenderer(ctx);
      expect(await ctx.page.evaluate('window.replacementAtlasDisposals')).toBe(0);
      expect(await ctx.page.evaluate('window.oldAtlasDisposals')).toBe(customGlyphs ? 0 : 1);
      await ctx.page.evaluate('window.addon.dispose()');
      expect(await ctx.page.evaluate('window.replacementAtlasDisposals')).toBe(1);
      expect(await ctx.page.evaluate('window.oldAtlasDisposals')).toBe(1);
    });

    test(`shared atlas and its events survive WebGPU replacement (customGlyphs=true -> ${customGlyphs})`, async () => {
      await openTerminal(ctx, { cols: 20, rows: 2 });
      await loadWebgpuAddon(ctx);
      await waitForWebgpuRender(ctx);
      await ctx.page.evaluate(`
        window.oldAddon = window.addon;
        window.oldAtlas = window.addon._renderer._charAtlas;
        window.oldAtlasDisposals = 0;
        const dispose = window.oldAtlas.dispose;
        window.oldAtlas.dispose = function () {
          window.oldAtlasDisposals++;
          return dispose.call(this);
        };
        const container = document.createElement('div');
        container.id = 'terminal-container-b';
        document.body.appendChild(container);
        window.termB = new window.Terminal({ cols: 20, rows: 2, allowProposedApi: true });
        window.termB.open(container);
      `);
      await createWebgpuAddon(ctx);
      await ctx.page.evaluate(`
        window.addonB = window.addon;
        window.termB.loadAddon(window.addonB);
      `);
      expect(await ctx.page.evaluate('window.addonB._renderer._charAtlas === window.oldAtlas')).toBe(true);
      await loadWebgpuAddon(ctx, customGlyphs);
      expect(await ctx.page.evaluate('window.addon._renderer._charAtlas === window.oldAtlas')).toBe(customGlyphs);
      expect(await ctx.page.evaluate('window.oldAtlasDisposals')).toBe(0);

      expect(await ctx.page.evaluate(`(() => {
        const events = [window.oldAddon, window.addon, window.addonB].map(addon => {
          const event = { added: [], removed: [] };
          addon.onAddTextureAtlasCanvas(canvas => event.added.push(canvas));
          addon.onRemoveTextureAtlasCanvas(canvas => event.removed.push(canvas));
          return event;
        });
        // Exercise real page lifecycle events without a large glyph flood.
        const atlases = new Set([window.addon._renderer._charAtlas, window.oldAtlas]);
        const removed = new Map();
        const added = new Map();
        for (const atlas of atlases) {
          removed.set(atlas, [...atlas.pages].map(page => page.canvas));
          atlas._evictAllPages();
          added.set(atlas, atlas._createNewPage().canvas);
        }
        return events.map((event, index) => {
          const atlas = index === 1 ? window.addon._renderer._charAtlas : window.oldAtlas;
          return {
            added: event.added.length,
            removed: event.removed.length,
            correctCanvases: event.added[0] === added.get(atlas) &&
              event.removed.every((canvas, i) => canvas === removed.get(atlas)[i])
          };
        });
      })()`)).toEqual([
        { added: 0, removed: 0, correctCanvases: false },
        { added: 1, removed: 1, correctCanvases: true },
        { added: 1, removed: 1, correctCanvases: true }
      ]);
      await ctx.proxy.write('Replacement owner');
      await waitForWebgpuRender(ctx);
      await assertWebgpuRenderer(ctx);
      await ctx.page.evaluate('window.oldAddon.dispose(); window.term.dispose(); window.term = window.termB; window.addon = window.addonB');
      expect(await ctx.page.evaluate('window.oldAtlasDisposals')).toBe(0);
      await ctx.proxy.write('Surviving owner');
      await waitForWebgpuRender(ctx);
      await assertWebgpuRenderer(ctx);
      await ctx.page.locator('#terminal-container-b .xterm-screen').screenshot();
      await ctx.page.evaluate('window.termB.dispose()');
      expect(await ctx.page.evaluate('window.oldAtlasDisposals')).toBe(1);
    });
  }

  test('one shared session renders multiple panes with a single device', async () => {
    await openTerminal(ctx, { cols: 20, rows: 4 });
    await ctx.page.evaluate(`(async () => {
      const { WebgpuSession } = await import('/addons/addon-webgpu/lib/addon-webgpu.mjs');
      window.session = await WebgpuSession.create();
      window.addon = window.session.createAddon();
      window.addonB = window.session.createAddon();
      window.term.loadAddon(window.addon);
    })()`);
    await assertWebgpuRenderer(ctx);
    await waitForWebgpuRender(ctx);
    await ctx.page.evaluate(`
      window.termB = new window.Terminal({ cols: 20, rows: 4, allowProposedApi: true });
      const container = document.createElement('div');
      container.id = 'terminal-container-b';
      document.body.appendChild(container);
      window.termB.open(container);
      window.termB.loadAddon(window.addonB);
    `);
    expect(await ctx.page.evaluate(`(() => {
      const a = window.term._core._renderService._renderer.value;
      const b = window.termB._core._renderService._renderer.value;
      return {
        sharedContext: a._backend._context === b._backend._context,
        sameDevice: a._backend._context.device === b._backend._context.device,
        kinds: [a._backend.constructor.name, b._backend.constructor.name]
      };
    })()`)).toEqual({ sharedContext: true, sameDevice: true, kinds: ['WebgpuBackend', 'WebgpuBackend'] });
    await ctx.page.evaluate(`(async () => {
      await new Promise(resolve => window.term.write('pane A', resolve));
      await new Promise(resolve => window.termB.write('pane B', resolve));
      const done = async term => {
        await new Promise(resolve => {
          const d = term.onRender(() => { d.dispose(); resolve(); });
          term.refresh(0, term.rows - 1);
        });
        await window.addon._device.queue.onSubmittedWorkDone();
      };
      await done(window.term);
      await done(window.termB);
    })()`);
    expect(await ctx.page.evaluate('window.term.buffer.active.getLine(0)?.translateToString(true)')).toContain('pane A');
    expect(await ctx.page.evaluate('window.termB.buffer.active.getLine(0)?.translateToString(true)')).toContain('pane B');
    await ctx.page.evaluate('window.addonB.dispose(); window.termB.dispose()');
    expect(await ctx.page.evaluate(`(async () => {
      await window.addon._device.queue.onSubmittedWorkDone();
      return window.addon._renderer.isDisposed === false;
    })()`)).toBe(true);
  });

  test('disposal is idempotent, restores the DOM renderer and destroys the device', async () => {
    await openTerminal(ctx);
    await loadWebgpuAddon(ctx);
    await waitForWebgpuRender(ctx);
    expect(await ctx.page.evaluate(`(async () => {
      const canvas = window.addon._renderer._canvas;
      window.addon.dispose();
      const renderer = window.term._core._renderService._renderer.value;
      window.addon.dispose();
      const loss = await window.addon._device.lost;
      return { renderer: renderer.constructor.name, unchanged: renderer === window.term._core._renderService._renderer.value, connected: canvas.isConnected, reason: loss.reason };
    })()`)).toEqual({ renderer: 'DomRenderer', unchanged: true, connected: false, reason: 'destroyed' });
    await ctx.proxy.write('DOM after disposal');
    await expect(ctx.page.locator('.xterm-rows')).toContainText('DOM after disposal');
  });

  test('device destruction emits context loss and restores a working DOM renderer', async () => {
    await openTerminal(ctx);
    await loadWebgpuAddon(ctx);
    await waitForWebgpuRender(ctx);
    expectedLosses = 1;
    await ctx.page.evaluate('window.addon._device.destroy()');
    await expect.poll(() => ctx.page.evaluate('window.gpuEvents.losses')).toBe(1);
    expect(await ctx.page.evaluate('window.term._core._renderService._renderer.value.constructor.name')).toBe('DomRenderer');
    await ctx.proxy.write('DOM after device loss');
    await expect(ctx.page.locator('.xterm-rows')).toContainText('DOM after device loss');
    await expect(ctx.page.locator('.xterm-screen canvas')).toHaveCount(0);
  });

  for (const action of ['dispose', 'destroy'] as const) {
    test(`a replacement WebGL renderer survives late WebGPU ${action}`, async () => {
      await openTerminal(ctx);
      await loadWebgpuAddon(ctx);
      await waitForWebgpuRender(ctx);
      await ctx.page.evaluate(`
        window.webgl = new window.WebglAddon();
        window.term.loadAddon(window.webgl);
        window.replacementRenderer = window.term._core._renderService._renderer.value;
      `);
      if (action === 'destroy') {
        expectedLosses = 1;
        await ctx.page.evaluate('window.addon._device.destroy()');
        await expect.poll(() => ctx.page.evaluate('window.gpuEvents.losses')).toBe(1);
      }
      await ctx.page.evaluate('window.addon.dispose()');
      await ctx.proxy.write('WebGL replacement');
      expect(await ctx.page.evaluate(`(() => {
        const renderer = window.term._core._renderService._renderer.value;
        return {
          unchanged: renderer === window.replacementRenderer && renderer === window.webgl._renderer,
          connected: renderer._canvas.isConnected,
          webgl: renderer._canvas.getContext('webgl2') instanceof WebGL2RenderingContext
        };
      })()`)).toEqual({ unchanged: true, connected: true, webgl: true });
      await ctx.page.locator('.xterm-screen').screenshot();
    });
  }

  test('an actual GPU validation error emits onError and restores the DOM renderer', async () => {
    await openTerminal(ctx);
    await loadWebgpuAddon(ctx);
    await waitForWebgpuRender(ctx);
    await assertWebgpuEvents(ctx);
    expectedErrors = 1;
    await ctx.page.evaluate(`(async () => {
      window.addon._device.createBuffer({ label: 'intentional invalid usage', size: 4, usage: 0 });
      await window.addon._device.queue.onSubmittedWorkDone();
    })()`);
    await expect.poll(() => ctx.page.evaluate('window.gpuEvents.errors.length')).toBe(1);
    const events = await ctx.page.evaluate<{ errors: string[], uncapturedErrors: { name: string, message: string }[] }>('window.gpuEvents');
    expect(events.uncapturedErrors).toEqual([{ name: 'GPUValidationError', message: events.errors[0] }]);
    expect(events.errors[0]).toMatch(/usage/i);
    expect(await ctx.page.evaluate('window.term._core._renderService._renderer.value.constructor.name')).toBe('DomRenderer');
    await ctx.proxy.write('DOM after validation error');
    await expect(ctx.page.locator('.xterm-rows')).toContainText('DOM after validation error');
  });

  test('resizing beyond the device texture width emits a synchronous onError and restores DOM', async () => {
    await openTerminal(ctx, { cols: 20, rows: 2, scrollback: 0 });
    await loadWebgpuAddon(ctx);
    await waitForWebgpuRender(ctx);
    expectedSynchronousErrors = 1;
    const dimensions = await ctx.page.evaluate<{ width: number, limit: number }>(`(() => {
      const renderer = window.addon._renderer;
      const limit = window.addon._device.limits.maxTextureDimension2D;
      const cols = Math.floor(limit / renderer.dimensions.device.cell.width) + 1;
      window.term.resize(cols, 2);
      return { width: renderer._canvas.width, limit };
    })()`);
    expect(dimensions.width).toBeGreaterThan(dimensions.limit);
    await expect.poll(() => ctx.page.evaluate('window.gpuEvents.errors')).toEqual(['Canvas exceeds the WebGPU texture size limit']);
    expect(await ctx.page.evaluate('window.term._core._renderService._renderer.value.constructor.name')).toBe('DomRenderer');
    expect(await ctx.page.evaluate('window.addon._renderer.isDisposed')).toBe(true);
    await expect(ctx.page.locator('.xterm-screen canvas')).toHaveCount(0);
    await ctx.proxy.write('DOM after oversized resize');
    await expect(ctx.page.locator('.xterm-rows')).toContainText('DOM after oversized resize');
    await ctx.page.evaluate('window.term.resize(40, 2)');
    await ctx.proxy.write('\r\nDOM after recovery');
    await expect(ctx.page.locator('.xterm-rows')).toContainText('DOM after recovery');
    await assertWebgpuEvents(ctx, 0, 0, expectedSynchronousErrors);
  });

  for (const customGlyphs of [true, false]) {
    test(`error-free render snapshots survive atlas clearing and resize (customGlyphs=${customGlyphs})`, async () => {
      await openTerminal(ctx, { cols: 20, rows: 4, cursorBlink: false });
      await createWebgpuAddon(ctx, customGlyphs);
      await ctx.page.evaluate(`
        window.addon._device.pushErrorScope('validation');
        window.term.loadAddon(window.addon);
      `);
      await assertWebgpuRenderer(ctx);
      await ctx.proxy.write('\x1b[?25l\x1b[48;2;240;32;16m    \x1b[0m\r\nASCII \u2500\u2502\u2588\u2591\r\n\x1b[1;4;38;2;64;192;255mStyled glyphs\x1b[0m');
      await waitForWebgpuRender(ctx);
      const screen = ctx.page.locator('.xterm-screen');
      const baseline = (await decodePng(new Uint8Array(await screen.screenshot()), { force32: true })).image;
      const x = Math.floor(baseline.width / 20 / 2);
      const y = Math.floor(baseline.height / 4 / 2);
      const pixel = (y * baseline.width + x) * 4;
      expect(Array.from(baseline.data.slice(pixel, pixel + 4)), 'Snapshot must contain the rendered truecolor background').toEqual([240, 32, 16, 255]);
      const glyphRow = baseline.data.slice(Math.ceil(baseline.height / 4) * baseline.width * 4, Math.floor(baseline.height / 2) * baseline.width * 4);
      expect(glyphRow.some((value, index) => index % 4 !== 3 && value > 0), 'Snapshot must contain visible glyphs').toBe(true);

      for (const operation of ['window.addon.clearTextureAtlas()', 'window.term.resize(30, 6)']) {
        await ctx.page.evaluate(operation);
        await waitForWebgpuRender(ctx);
        if (operation === 'window.term.resize(30, 6)') {
          const resized = (await decodePng(new Uint8Array(await screen.screenshot()), { force32: true })).image;
          expect(resized.width).toBeGreaterThan(baseline.width);
          expect(resized.height).toBeGreaterThan(baseline.height);
          await ctx.page.evaluate('window.term.resize(20, 4)');
          await waitForWebgpuRender(ctx);
        }
        const actual = (await decodePng(new Uint8Array(await screen.screenshot()), { force32: true })).image;
        expect(actual.width).toBe(baseline.width);
        expect(actual.height).toBe(baseline.height);
        expect(Buffer.compare(Buffer.from(actual.data), Buffer.from(baseline.data)), `Snapshot changed after ${operation}`).toBe(0);
      }
      expect(await ctx.page.evaluate(`(async () => {
        await window.addon._device.queue.onSubmittedWorkDone();
        const error = await window.addon._device.popErrorScope();
        return error ? { name: error.constructor.name, message: error.message } : null;
      })()`), 'Real GPU rendering must produce no validation errors').toBeNull();
      await assertWebgpuRenderer(ctx);
      await assertWebgpuEvents(ctx);
    });
  }
});
