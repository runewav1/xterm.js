/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import test, { expect, type Page } from '@playwright/test';
import { decodePng } from '@lunapaint/png-codec';
import { ISharedRendererTestContext, injectSharedRendererTests, injectSharedRendererTestsStandalone } from '../../../test/playwright/SharedRendererTests';
import { openTerminal } from '../../../test/playwright/TestUtils';
import { IWebgpuTestContext, assertWebgpuEvents, assertWebgpuRenderer, createWebgpuTestContext, loadWebgpuAddon, waitForWebgpuRender } from './WebgpuTestUtils';

test.describe('WebGPU Renderer Integration Tests', () => {
  let ctx: IWebgpuTestContext;
  const ctxWrapper: ISharedRendererTestContext = { value: undefined! };

  test.beforeAll(async ({ browser }) => {
    ctx = await createWebgpuTestContext(browser);
    await openTerminal(ctx);
    ctxWrapper.value = ctx;
    await loadWebgpuAddon(ctx);
  });

  test.afterEach(async () => {
    await waitForWebgpuRender(ctx);
    await assertWebgpuEvents(ctx);
    await assertWebgpuRenderer(ctx);
  });

  test.afterAll(async () => {
    if (ctx) {
      try {
        await ctx.page.evaluate('window.term?.dispose()');
        await assertWebgpuEvents(ctx);
      } finally {
        await ctx.page.close();
      }
    }
  });

  injectSharedRendererTests(ctxWrapper);
  injectSharedRendererTestsStandalone(ctxWrapper, async () => {
    await loadWebgpuAddon(ctx);
  });

  async function writeBoxRow(page: Page): Promise<void> {
    await page.evaluate(`(() => {
      window.term.reset();
      window.term.options.theme = { background: '#000000', foreground: '#ffffff' };
      window.term.writeln('━'.repeat(window.term.cols));
    })()`);
    await page.evaluate(`(async () => {
      await new Promise(resolve => {
        const listener = window.term.onRender(() => { listener.dispose(); resolve(); });
        window.term.refresh(0, window.term.rows - 1);
      });
      await window.addon._device.queue.onSubmittedWorkDone();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
  }

  async function assertBoxRowHasNoBackgroundGaps(page: Page, row = 0): Promise<void> {
    const buffer = await page.locator('#terminal-container .xterm-screen').screenshot();
    const { image } = await decodePng(new Uint8Array(buffer), { force32: true });
    const cols = await page.evaluate<number>('window.term.cols');
    const rows = await page.evaluate<number>('window.term.rows');
    const cellWidth = image.width / cols;
    const cellHeight = image.height / rows;
    const y = Math.floor((row + 0.5) * cellHeight);
    let backgroundPixels = 0;
    for (let x = 1; x < image.width - 1; x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i] === 0 && image.data[i + 1] === 0 && image.data[i + 2] === 0) {
        backgroundPixels++;
      }
    }
    // A run of heavy horizontal box-drawing glyphs must not contain background
    // (black) pixels between adjacent cells, otherwise TUI lines would break.
    expect(backgroundPixels).toBeLessThan(image.width * 0.05);
  }

  test('box-drawing strokes stay contiguous across cell boundaries', async () => {
    await writeBoxRow(ctx.page);
    await assertBoxRowHasNoBackgroundGaps(ctx.page);
  });

  interface IGlyphRowScan {
    gridW: number;
    gridH: number;
    canvasW: number;
    canvasH: number;
    cellW: number;
    cellH: number;
    firstInkX: number;
    lastInkX: number;
    shotWidth: number;
    shotHeight: number;
  }

  /**
   * Deliberately forces the canvas backing store to `grid ± delta` (disposing
   * the ResizeObserver so it cannot correct the size) and sizes the canvas
   * element's CSS box to the same value, so a composited screenshot reads
   * backing-store pixels 1:1 with no CSS rescale. A single full block glyph is
   * rendered at a known column and the exact horizontal ink extent is scanned.
   * CSS-scaled screenshots would cancel the viewport scaling and hide pitch
   * errors, so the canvas must be read at backing resolution.
   */
  async function readForcedBackingGlyphScan(page: Page, cols: number, rows: number, col: number, fontSize: number, delta: number): Promise<IGlyphRowScan> {
    const dims = await page.evaluate<{ gridW: number, gridH: number, canvasW: number, canvasH: number, cellW: number, cellH: number }>(`(() => {
      const term = window.term;
      term.options.fontSize = ${fontSize};
      term.resize(${cols}, ${rows});
      const renderer = term._core._renderService._renderer.value;
      // Let the char measure and dimensions settle for the new font size.
      return new Promise(resolve => {
        const l = term.onRender(() => { l.dispose(); resolve(); });
        term.refresh(0, term.rows - 1);
      }).then(() => {
        return window.addon._device.queue.onSubmittedWorkDone();
      }).then(() => {
        renderer._observerDisposable.value.dispose();
        const canvas = renderer._canvas;
        const gridW = renderer.dimensions.device.canvas.width;
        const gridH = renderer.dimensions.device.canvas.height;
        canvas.width = gridW + ${delta};
        canvas.height = gridH + ${delta};
        canvas.style.width = (gridW + ${delta}) + 'px';
        canvas.style.height = (gridH + ${delta}) + 'px';
        term.reset();
        term.options.theme = { background: '#000000', foreground: '#ffffff' };
        term.writeln(' '.repeat(${col}) + '█');
        const wait = () => new Promise(resolve => {
          const l = term.onRender(() => { l.dispose(); resolve(); });
          term.refresh(0, term.rows - 1);
        });
        return wait().then(() => window.addon._device.queue.onSubmittedWorkDone())
          .then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          .then(() => ({ gridW, gridH, canvasW: canvas.width, canvasH: canvas.height, cellW: gridW / ${cols}, cellH: gridH / ${rows} }));
      });
    })()`);
    const buffer = await page.locator('#terminal-container .xterm-screen').screenshot();
    const { image } = await decodePng(new Uint8Array(buffer), { force32: true });
    const rowY = Math.floor(dims.cellH / 2);
    const isInk = (x: number): boolean => {
      const i = (rowY * image.width + x) * 4;
      return image.data[i] > 180 && image.data[i + 1] > 180 && image.data[i + 2] > 180;
    };
    let firstInkX = -1;
    let lastInkX = -1;
    for (let x = 0; x < image.width; x++) {
      if (isInk(x)) {
        if (firstInkX === -1) {
          firstInkX = x;
        }
        lastInkX = x;
      }
    }
    return { ...dims, firstInkX, lastInkX, shotWidth: image.width, shotHeight: image.height };
  }

  test('glyph positions match exact-size backing rendering with forced backing mismatches', async () => {
    const cols = 40;
    const rows = 6;
    const col = 30;
    // Fractional sizes are common when applications implement fine-grained
    // terminal zoom controls. Keep these in the same backing-mismatch sweep as
    // integer sizes so atlas metrics and grid positioning cannot drift apart.
    for (const fontSize of [10, 10.25, 10.5, 10.75, 12, 16]) {
      for (const delta of [0, 1, -1, 8, -8]) {
        const scan = await readForcedBackingGlyphScan(ctx.page, cols, rows, col, fontSize, delta);
        const tag = `fontSize=${fontSize} delta=${delta}`;
        // The backing must be exactly grid + delta, proving the mismatch was
        // forced rather than silently corrected by the observer.
        expect(scan.canvasW, `${tag} backing width`).toBe(scan.gridW + delta);
        expect(scan.canvasH, `${tag} backing height`).toBe(scan.gridH + delta);
        // The screenshot must read backing pixels 1:1 (the screen element keeps
        // the grid CSS width), so no rescaling can hide a pitch error.
        expect(scan.shotWidth, `${tag} shot width`).toBe(scan.gridW);
        // The block glyph must start at its exact intended device pixel column.
        const expectedLeft = Math.round(col * scan.cellW);
        expect(scan.firstInkX, `${tag} left edge`).toBe(expectedLeft);
        // Its right edge must be inside the intended cell, not clipped or smeared.
        expect(scan.lastInkX, `${tag} right edge`).toBeGreaterThanOrEqual(expectedLeft + Math.floor(scan.cellW * 0.75));
        expect(scan.lastInkX, `${tag} right edge`).toBeLessThan(expectedLeft + scan.cellW);
      }
    }
  });

  test('box-drawing strokes stay contiguous at fractional device pixel ratios', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 700 }, deviceScaleFactor: 1.25 });
    const page = await context.newPage();
    try {
      await page.goto('/test');
      await page.evaluate(`(() => {
        window.term = new window.Terminal({ allowProposedApi: true, cols: 80, rows: 5, allowTransparency: false, theme: { background: '#000000', foreground: '#ffffff' } });
        const container = document.querySelector('#terminal-container');
        const element = document.createElement('div');
        element.style.width = '100%';
        element.style.height = '100%';
        container.replaceChildren(element);
        window.term.open(element);
      })()`);
      await page.waitForSelector('.xterm-rows');
      await page.evaluate(`(async () => {
        ({ WebgpuAddon } = await import('/addons/addon-webgpu/lib/addon-webgpu.mjs'));
        window.addon = await WebgpuAddon.create();
        window.term.loadAddon(window.addon);
      })()`);
      await page.evaluate(`window.addon._device.addEventListener('uncapturederror', event => {
        window.gpuUncapturedErrors ??= [];
        window.gpuUncapturedErrors.push(event.error.message);
      })`);
      // Sweep terminal widths that produce fractional-DPR canvas sizing
      // mismatches for the default cell metrics.
      for (const cols of [60, 80, 81, 100, 101]) {
        await page.evaluate(`window.term.resize(${cols}, 5)`);
        await writeBoxRow(page);
        await assertBoxRowHasNoBackgroundGaps(page);
      }
      const uncapturedErrors = await page.evaluate('window.gpuUncapturedErrors ?? []');
      expect(uncapturedErrors, 'No GPU validation errors may be raised').toEqual([]);
    } finally {
      await context.close();
    }
  });
});
