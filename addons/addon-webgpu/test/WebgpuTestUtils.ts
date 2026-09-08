/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { Browser, expect } from '@playwright/test';
import { ITestContext, createTestContext } from '../../../test/playwright/TestUtils';

export interface IWebgpuTestContext extends ITestContext {
  pageErrors: string[];
}

export async function createWebgpuTestContext(browser: Browser): Promise<IWebgpuTestContext> {
  const ctx = await createTestContext(browser);
  const pageErrors = (await ctx.page.pageErrors()).map(e => e.message);
  ctx.page.on('pageerror', e => pageErrors.push(e.message));
  return { ...ctx, pageErrors };
}

export async function createWebgpuAddon(ctx: IWebgpuTestContext, customGlyphs: boolean = true): Promise<void> {
  // Keep the import inside a browser script so CommonJS test compilation cannot rewrite it.
  await ctx.page.evaluate(`(async () => {
    const url = '/addons/addon-webgpu/lib/addon-webgpu.mjs';
    let WebgpuAddon;
    try {
      ({ WebgpuAddon } = await import(url));
    } catch (error) {
      throw new Error('Cannot import ' + url + '. Build addon-webgpu and expose /addons on the demo server. ' + error);
    }
    window.gpuEvents ??= { errors: [], uncapturedErrors: [], losses: 0 };
    try {
      window.addon = await WebgpuAddon.create({ customGlyphs: ${customGlyphs} });
    } catch (error) {
      throw new Error('WebGPU initialization failed. Use full Chromium (channel: chromium), a supported GPU/driver, and localhost. No renderer fallback is allowed. ' + error);
    }
    window.addon.onError(error => window.gpuEvents.errors.push(error.message));
    window.addon.onContextLoss(() => window.gpuEvents.losses++);
    window.addon._device.addEventListener('uncapturederror', event => {
      window.gpuEvents.uncapturedErrors.push({ name: event.error.constructor.name, message: event.error.message });
    });
  })()`);
}

export async function loadWebgpuAddon(ctx: IWebgpuTestContext, customGlyphs: boolean = true): Promise<void> {
  await createWebgpuAddon(ctx, customGlyphs);
  await ctx.page.evaluate('window.term.loadAddon(window.addon)');
  await assertWebgpuRenderer(ctx);
}

export async function assertWebgpuRenderer(ctx: IWebgpuTestContext): Promise<void> {
  expect(await ctx.page.evaluate(`(() => {
    const renderer = window.term._core._renderService._renderer.value;
    const canvas = renderer._canvas;
    const context = canvas?.getContext('webgpu');
    return {
      renderer: renderer.constructor.name,
      ownedByAddon: renderer === window.addon._renderer,
      connected: canvas?.isConnected === true,
      context: context?.constructor.name,
      backendContext: context !== undefined && context === renderer._backend?._canvasContext
    };
  })()`), 'WebGPU must actually render; DOM/WebGL fallback is a test failure').toEqual({
    renderer: 'GpuRenderer',
    ownedByAddon: true,
    connected: true,
    context: 'GPUCanvasContext',
    backendContext: true
  });
}

export async function waitForWebgpuRender(ctx: IWebgpuTestContext): Promise<void> {
  await ctx.page.evaluate(`(async () => {
    await new Promise(resolve => {
      const listener = window.term.onRender(() => { listener.dispose(); resolve(); });
      window.term.refresh(0, window.term.rows - 1);
    });
    await window.addon._device.queue.onSubmittedWorkDone();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise(resolve => setTimeout(resolve, 0));
  })()`);
}

export async function assertWebgpuEvents(ctx: IWebgpuTestContext, errors: number = 0, losses: number = 0, synchronousErrors: number = 0): Promise<void> {
  // Device errors are delivered asynchronously, including after a screenshot or disposal.
  await ctx.page.evaluate('new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))');
  expect(ctx.pageErrors, 'Unexpected browser page errors').toEqual([]);
  const events = await ctx.page.evaluate<{ errors: string[], uncapturedErrors: { name: string, message: string }[], losses: number }>(
    'window.gpuEvents ?? { errors: [], uncapturedErrors: [], losses: 0 }'
  );
  expect(events.errors, 'Unexpected WebgpuAddon.onError events').toHaveLength(errors + synchronousErrors);
  expect(events.uncapturedErrors, 'Unexpected GPUDevice uncapturederror events').toHaveLength(errors);
  expect(events.losses, 'Unexpected WebgpuAddon.onContextLoss events').toBe(losses);
}
