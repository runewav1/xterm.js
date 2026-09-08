/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import test from '@playwright/test';
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
});
