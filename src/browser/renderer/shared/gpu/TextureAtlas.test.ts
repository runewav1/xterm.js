/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { TextureAtlas, clearColor, checkCompletelyTransparent } from './TextureAtlas';
import { IBoundingBox, ICharAtlasConfig, IDirtyRect, IRasterizedGlyph } from './Types';
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
      deviceCellWidth: 10, deviceCellHeight: 20, deviceCharWidth: 8, deviceCharHeight: 18,
      lineHeight: 1, maxTextureSize: 4096, maxAtlasPages: 16
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

  it('preserves asymmetric glyph bounds while reading pixel data once', () => {
    const findBounds = (atlas as any)._findGlyphBoundingBox as (
      image: ImageData, bounds: IBoundingBox, width: number, restricted: boolean, custom: boolean, padding: number
    ) => IRasterizedGlyph;
    const canvasWidth = canvases[1].width;
    const canvasHeight = canvases[1].height;
    let seed = 12345;
    for (const restricted of [false, true]) {
      for (const custom of [false, true]) {
        for (let trial = 0; trial < 32; trial++) {
          const pixels = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
          for (let pixel = 0; pixel < (trial === 0 ? 0 : 8); pixel++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const offset = (seed % (canvasWidth * canvasHeight)) * 4;
            pixels[offset + 3] = 1 + (seed % 255);
          }
          let reads = 0;
          const image = {
            get data(): Uint8ClampedArray { reads++; return pixels; }
          } as ImageData;
          const padding = 4;
          const width = restricted ? 10 : 24;
          const height = restricted ? 20 : canvasHeight;
          // Independent full-region reference. The original searches top/bottom
          // without padding, left with padding, and right starting at padding.
          let top = height;
          let bottom = -1;
          let left = padding + width;
          let right = -1;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < padding + width; x++) {
              if (pixels[(y * canvasWidth + x) * 4 + 3] !== 0) {
                left = Math.min(left, x);
                if (x >= padding) right = Math.max(right, x);
                if (x < width) {
                  top = Math.min(top, y);
                  bottom = Math.max(bottom, y);
                }
              }
            }
          }
          const expected = {
            top: top === height ? 0 : top,
            bottom: bottom === -1 ? height : bottom,
            left: left === padding + width ? 0 : left,
            right: right === -1 ? width : right
          };
          const bounds = { top: 0, bottom: 0, left: 0, right: 0 };
          const glyph = findBounds.call(atlas, image, bounds, 24, restricted, custom, padding);
          assert.deepEqual(bounds, expected);
          assert.deepEqual(glyph.size, { x: expected.right - expected.left + 1, y: expected.bottom - expected.top + 1 });
          assert.deepEqual(glyph.offset, { x: -expected.left + padding + (restricted || custom ? 1 : 0), y: -expected.top + padding });
          assert.equal(reads, 1);
        }
      }
    }
  });
});

describe('glyph pixel processing', () => {
  it('preserves exact and threshold color clearing with one data getter read', () => {
    const bg = { rgba: 0x64788CFF, css: '#64788c' };
    const fg = { rgba: 0xDCF0FAFF, css: '#dcf0fa' };
    for (const threshold of [false, true]) {
      const pixels = new Uint8ClampedArray([
        100, 120, 140, 255,
        101, 121, 141, 128,
        220, 240, 250, 255,
        110, 130, 150, 64,
        100, 120, 140, 0
      ]);
      let reads = 0;
      const image = {
        get data(): Uint8ClampedArray { reads++; return pixels; }
      } as ImageData;
      assert.isFalse(clearColor(image, bg, fg, threshold));
      assert.deepEqual(Array.from(pixels), [
        100, 120, 140, 0,
        101, 121, 141, threshold ? 0 : 128,
        220, 240, 250, 255,
        110, 130, 150, 64,
        100, 120, 140, 0
      ]);
      assert.equal(reads, 1);
    }
  });

  it('checks transparency using alpha only with one data getter read', () => {
    const pixels = new Uint8ClampedArray([255, 255, 255, 0, 1, 2, 3, 0]);
    let reads = 0;
    const image = {
      get data(): Uint8ClampedArray { reads++; return pixels; }
    } as ImageData;
    assert.isTrue(checkCompletelyTransparent(image));
    assert.equal(reads, 1);
    pixels[7] = 1;
    assert.isFalse(checkCompletelyTransparent(image));
    assert.equal(reads, 2);
  });
});
