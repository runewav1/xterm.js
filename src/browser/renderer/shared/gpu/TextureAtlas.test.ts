/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { TextureAtlas } from './TextureAtlas';
import { ICharAtlasConfig, IRasterizedGlyph } from './Types';
import { MockLogService, MockUnicodeService } from '../../../../common/TestUtils.test';
import { FgFlags } from '../../../../common/buffer/Constants';

describe('TextureAtlas lifecycle', () => {
  let atlas: TextureAtlas;
  let saves: number;
  let canvases: HTMLCanvasElement[];

  beforeEach(() => {
    saves = 0;
    canvases = [];
    const document = {
      createElement: () => {
        const canvas = {
          width: 0, height: 0,
          remove: () => {},
          getContext: () => ({ save: () => saves++, restore: () => saves--, clearRect: () => {} })
        } as unknown as HTMLCanvasElement;
        canvases.push(canvas);
        return canvas;
      }
    } as unknown as Document;
    atlas = new TextureAtlas(document, {
      deviceCellWidth: 10, deviceCellHeight: 20, maxTextureSize: 4096, maxAtlasPages: 16
    } as ICharAtlasConfig, new MockUnicodeService(), new MockLogService());
  });

  afterEach(() => atlas.dispose());

  it('does not retain canvas states for invisible cache misses', () => {
    for (let i = 0; i < 1000; i++) {
      atlas.getRasterizedGlyph(65, i, FgFlags.INVISIBLE, 0, false, undefined);
    }
    assert.equal(saves, 0);
  });

  it('clears page glyph references and utilization', () => {
    const page = atlas.pages[0] as typeof atlas.pages[number] & {
      addGlyph(glyph: IRasterizedGlyph): void;
      clear(): void;
      glyphs: IRasterizedGlyph[];
      percentageUsed: number;
    };
    for (let i = 0; i < 10; i++) {
      page.addGlyph({ size: { x: 10, y: 20 } } as IRasterizedGlyph);
      page.clear();
      assert.equal(page.glyphs.length, 0);
      assert.equal(page.percentageUsed, 0);
    }
  });

  it('releases high-water backing dimensions on clear and invalidates shared models', () => {
    const oldPage = atlas.pages[0].canvas;
    oldPage.width = oldPage.height = 4096;
    canvases[1].width = 4096;
    const version = atlas.pageLayoutVersion;
    atlas.clearTexture();
    assert.equal(oldPage.width * oldPage.height, 0);
    assert.equal(atlas.pages.length, 1);
    assert.equal(atlas.pages[0].canvas.width, 512);
    assert.equal(canvases[1].width, 44);
    assert.isAbove(atlas.pageLayoutVersion, version);
  });

  it('cancels queued warmup on disposal', async () => {
    atlas.warmUp();
    atlas.dispose();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(atlas.pages.length, 0);
    assert.ok(canvases.every(c => c.width === 0 && c.height === 0));
    assert.equal(saves, 0);
  });
});
