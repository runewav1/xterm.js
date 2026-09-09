/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { TextureAtlas } from './TextureAtlas';
import { ICharAtlasConfig, IDirtyRect, IRasterizedGlyph } from './Types';
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

  it('tracks dirty rects with versions for incremental uploads', () => {
    const page = atlas.pages[0] as typeof atlas.pages[number] & {
      version: number;
      addDirtyRect(x: number, y: number, width: number, height: number, version: number): void;
      dirtyRects: { version: number }[];
    };
    const v1 = ++page.version;
    page.addDirtyRect(0, 0, 10, 20, v1);
    const afterV0 = atlas.getDirtyRects(0, 0);
    assert.strictEqual(afterV0.length, 1);
    assert.deepStrictEqual(afterV0[0] as IDirtyRect & { version: number }, { x: 0, y: 0, width: 10, height: 20, version: v1 });
    assert.deepStrictEqual(atlas.getDirtyRects(0, v1), []);
    const v2 = ++page.version;
    page.addDirtyRect(30, 40, 5, 6, v2);
    const afterV1 = atlas.getDirtyRects(0, v1);
    assert.strictEqual(afterV1.length, 1);
    assert.deepStrictEqual(afterV1[0] as IDirtyRect & { version: number }, { x: 30, y: 40, width: 5, height: 6, version: v2 });
    assert.deepStrictEqual(atlas.getDirtyRects(99, 0), []);
  });

  it('returns the newer-record suffix via binary search without cloning records', () => {
    const page = atlas.pages[0] as typeof atlas.pages[number] & {
      version: number;
      addDirtyRect(x: number, y: number, width: number, height: number, version: number): void;
      dirtyRects: { x: number, y: number, width: number, height: number, version: number }[];
    };
    const versions: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const v = ++page.version;
      versions.push(v);
      page.addDirtyRect(i, i, i, i, v);
    }
    const rects = atlas.getDirtyRects(0, versions[1]);
    assert.strictEqual(rects.length, 3);
    for (let i = 0; i < rects.length; i++) {
      assert.strictEqual(rects[i], page.dirtyRects[i + 2], 'records must be returned by reference');
    }
    assert.deepStrictEqual(
      Array.from(rects, r => [r.x, r.y, r.width, r.height]),
      [[3, 3, 3, 3], [4, 4, 4, 4], [5, 5, 5, 5]]
    );
    assert.deepStrictEqual(atlas.getDirtyRects(0, versions[4]), []);
  });

  it('records a full-page dirty rect when a page is cleared', () => {
    const page = atlas.pages[0] as typeof atlas.pages[number] & {
      version: number;
      clear(): void;
      dirtyRects: { x: number, y: number, width: number, height: number }[];
    };
    const before = page.version;
    page.clear();
    assert.isAbove(page.version, before);
    assert.strictEqual(page.dirtyRects.length, 1);
    const cleared = atlas.getDirtyRects(0, before);
    assert.strictEqual(cleared.length, 1);
    assert.deepStrictEqual(cleared[0] as IDirtyRect & { version: number }, { x: 0, y: 0, width: page.canvas.width, height: page.canvas.height, version: page.version });
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
