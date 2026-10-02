/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { ImageStorage } from './ImageStorage';
import { BufferLine } from 'common/buffer/BufferLine';
import { CellData } from 'common/buffer/CellData';
import { SINGLE_UNDERLINE_ATTRS } from 'common/buffer/AttributeData';
import { FgFlags, BgFlags, UnderlineStyle } from 'common/buffer/Constants';

describe('ImageStorage cell metadata', () => {
  it('clones shared underline attributes before attaching isolated image tiles', () => {
    const cell = new CellData();
    cell.fg = FgFlags.UNDERLINE;
    cell.bg = BgFlags.HAS_EXTENDED;
    cell.extended = SINGLE_UNDERLINE_ATTRS;
    const line = new BufferLine(2, cell);
    const storage = Object.create(ImageStorage.prototype) as any;
    storage._workCell = new CellData();
    storage._images = new Map();
    storage._writeToCell(line, 0, 10, 1);
    storage._writeToCell(line, 1, 10, 2);
    const first = line.getExtended(0);
    const second = line.getExtended(1);
    assert.notStrictEqual(first, SINGLE_UNDERLINE_ATTRS);
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.payload, second.payload);
    assert.equal(first.underlineStyle, UnderlineStyle.SINGLE);
    assert.deepEqual({ ...(first.payload as object) }, { imageId: 10, tileId: 1 });
    assert.deepEqual({ ...(second.payload as object) }, { imageId: 10, tileId: 2 });
    storage._writeToCell(line, 0, 11, 3);
    assert.deepEqual({ ...(first.payload as object) }, { imageId: 11, tileId: 3 });
    assert.deepEqual({ ...(second.payload as object) }, { imageId: 10, tileId: 2 });
    assert.isUndefined(SINGLE_UNDERLINE_ATTRS.payload);
  });
});
