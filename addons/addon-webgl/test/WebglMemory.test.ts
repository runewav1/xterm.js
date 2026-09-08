/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import test, { expect } from '@playwright/test';
import { ITestContext, createTestContext, openTerminal } from '../../../test/playwright/TestUtils';

test.describe('WebGL live atlas resources', () => {
  let ctx: ITestContext;
  test.beforeAll(async ({ browser }) => ctx = await createTestContext(browser));
  test.afterAll(async () => ctx.page.close());

  test('does not retain closed pane DOM through a surviving shared atlas', async () => {
    await openTerminal(ctx);
    const samples = await ctx.page.evaluate(() => {
      const w = window as any;
      const survivor = new w.WebglAddon();
      w.term.loadAddon(survivor);
      const atlas = survivor._renderer._charAtlas;
      const samples: boolean[] = [];
      try {
        for (let cycle = 0; cycle < 5; cycle++) {
          const container = document.createElement('div');
          document.body.append(container);
          const term = new w.Terminal({ allowProposedApi: true });
          term.open(container);
          const addon = new w.WebglAddon();
          term.loadAddon(addon);
          if (addon._renderer._charAtlas !== atlas) {
            throw new Error('Expected a shared atlas');
          }
          atlas.getRasterizedGlyph(65, cycle + 1234, 0, 0, false, term._core.screenElement);
          if (!term.element.contains(atlas._tmpCanvas)) {
            throw new Error('Scratch canvas must be attached before disposal');
          }
          term.dispose();
          container.remove();
          samples.push(atlas._tmpCanvas.parentElement === null && atlas.pages.length > 0);
        }
      } finally {
        survivor.dispose();
      }
      return samples;
    });
    expect(samples).toEqual(Array(5).fill(true));
  });

  test('releases unused texture slots and canvas capacity after repeated growth and clear', async () => {
    await openTerminal(ctx);
    const result = await ctx.page.evaluate(() => {
      const w = window as any;
      const addon = new w.WebglAddon();
      w.term.loadAddon(addon);
      const renderer = addon._renderer;
      const atlas = renderer._charAtlas;
      const glyphRenderer = renderer._glyphRenderer.value;
      const gl = glyphRenderer._gl as WebGL2RenderingContext;
      const uploads: number[][] = [];
      const original = gl.texImage2D.bind(gl);
      gl.texImage2D = ((...args: any[]) => {
        if (args.length === 9) {
          uploads.push([args[3], args[4]]);
        }
        (original as any)(...args);
      }) as typeof gl.texImage2D;
      const samples: { pages: number, retiredPixels: number, uploadedPages: number }[] = [];
      try {
        for (let cycle = 0; cycle < 3; cycle++) {
          atlas._createNewPage();
          atlas._createNewPage();
          glyphRenderer.render(renderer._model);
          const retired = atlas.pages.map((p: any) => p.canvas as HTMLCanvasElement);
          atlas.clearTexture();
          glyphRenderer.render(renderer._model);
          samples.push({
            pages: atlas.pages.length,
            retiredPixels: retired.reduce((sum: number, c: HTMLCanvasElement) => sum + c.width * c.height, 0),
            uploadedPages: glyphRenderer._uploadedAtlasPageCount
          });
        }
        return { samples, resets: uploads.filter(size => size[0] === 1 && size[1] === 1).length, error: gl.getError() };
      } finally {
        gl.texImage2D = original;
        addon.dispose();
      }
    });
    expect(result.samples).toEqual(Array(3).fill({ pages: 1, retiredPixels: 0, uploadedPages: 1 }));
    expect(result.resets).toBe(6);
    expect(result.error).toBe(0);
  });
});
