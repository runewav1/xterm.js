/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { CharData, IAttributeData, IBufferLine, ICellData, IExtendedAttrs } from './Types';
import { AttributeData, SINGLE_UNDERLINE_ATTRS } from './AttributeData';
import { CellData } from './CellData';
import { Attributes, BgFlags, CHAR_DATA_ATTR_INDEX, CHAR_DATA_CHAR_INDEX, CHAR_DATA_WIDTH_INDEX, Content, NULL_CELL_CHAR, NULL_CELL_CODE, NULL_CELL_WIDTH, WHITESPACE_CELL_CHAR } from './Constants';
import { stringFromCodePoint } from '../input/TextDecoder';

// Buffer memory layout (interned styles):
//
//   _content  `Uint32Array` - wcwidth(2) combined(1) codepoint(21)  -> 4B/cell
//   _styleIds `Uint16Array` - index into the per-line style table   -> 2B/cell
//              (promoted to Uint32Array only if 16-bit ids are exhausted)
//
// The two fg/bg words (previously 8B/cell) are replaced by a per-line interned
// style table. Style id 0 is the default (fg = 0, bg = 0); a default line
// keeps only that sentinel entry. This mirrors the style-id interning used by Ghostty
// (per-page `StyleSet` with `default_id = 0`) and the inline-fast-path /
// out-of-line-slow-path split used by Alacritty and WezTerm. Rare data -
// extended attributes and combined strings - stays in the sparse per-line maps,
// similar to foot's side tables.

const enum Constants {
  /** Style id for the default style (fg = 0, bg = 0). Never a real table entry. */
  DEFAULT_STYLE_ID = 0,
  /** Factor when to cleanup underlying array buffer after shrinking. */
  CLEANUP_THRESHOLD = 2,
  /**
   * Table size at which a line switches from a linear style scan to a hash
   * index. Small tables scan faster than a Map; style-heavy lines (syntax
   * highlighting, TUI color churn) would otherwise pay an O(table) scan per cell.
   */
  STYLE_INDEX_THRESHOLD = 16
}

interface IExtendedAttrsExt extends IExtendedAttrs {
  _ext: number;
  _urlId: number;
}

export const DEFAULT_ATTR_DATA = Object.freeze(new AttributeData());

/**
 * Shared empty `_combined` map. Lines point at it until they store their first
 * combined string (copy-on-write), so blank lines and copies of plain lines
 * never allocate or scan a map. Frozen so an unguarded write throws instead of
 * leaking into every line sharing it.
 */
const EMPTY_COMBINED: {[index: number]: string} = Object.freeze(Object.create(null));

// Work variables to avoid garbage collection
const $extended = DEFAULT_ATTR_DATA.extended.clone() as IExtendedAttrsExt;
const $nullCell = CellData.fromCharData([0, NULL_CELL_CHAR, NULL_CELL_WIDTH, NULL_CELL_CODE]);

/**
 * Typed array based bufferline implementation.
 *
 * There are 2 ways to insert data into the cell buffer:
 * - `setCellFromCodepoint` + `addCodepointToCell`
 *   Use these for data that is already UTF32.
 *   Used during normal input in `InputHandler` for faster buffer access.
 * - `setCell`
 *   This method takes a CellData object and stores the data in the buffer.
 *   Use `CellData.fromCharData` to create the CellData object (e.g. from JS string).
 *
 * To retrieve data from the buffer use either one of the primitive methods
 * (if only one particular value is needed) or `loadCell`. For `loadCell` in a loop
 * memory allocs / GC pressure can be greatly reduced by reusing the CellData object.
 */
export class BufferLine implements IBufferLine {
  protected _content: Uint32Array;
  protected _styleIds: Uint16Array | Uint32Array;
  /** Interned fg words indexed by style id; index 0 is the implicit default. */
  protected _styleFg: number[] = [0];
  /** Interned bg words indexed by style id; index 0 is the implicit default. */
  protected _styleBg: number[] = [0];
  /**
   * Lazy fg -> style id index. A foreground with multiple backgrounds promotes
   * its entry to a bg -> id map; the common unique-pair case needs only one
   * lookup and no per-foreground Map allocation.
   */
  protected _styleIndex: Map<number, number | Map<number, number>> | undefined;
  /**
   * Most recently interned non-default style. Printing a run of text with one
   * SGR state re-interns the same pair per cell; this turns that into a single
   * compare even when the table is large. `-1` when invalid, and must be reset
   * whenever style ids are renumbered or the table is replaced.
   */
  private _lastStyleId = -1;
  private _lastStyleFg = 0;
  private _lastStyleBg = 0;
  /**
   * Sparse cache; only read when `IS_COMBINED_MASK` is set in `_content`.
   * Shares the frozen {@link EMPTY_COMBINED} until written, see `_writableCombined`.
   */
  protected _combined: {[index: number]: string} = EMPTY_COMBINED;
  /**
   * Sparse cache; only read when `HAS_EXTENDED` is set in the bg word.
   * `undefined` until written, see `_writableExtendedAttrs`.
   */
  // Explicitly initialized so every line shares one hidden class.
  protected _extendedAttrs: {[index: number]: IExtendedAttrs | undefined} | undefined = undefined;
  public length: number;

  /** line text cache */
  protected _cacheValid = false;
  protected _cache: string = '';
  protected _cacheTrimmed = false;

  constructor(
    cols: number,
    fillCellData?: ICellData,
    public isWrapped: boolean = false
  ) {
    this._content = new Uint32Array(cols);
    this._styleIds = new Uint16Array(cols);
    this._fillRange(0, cols, fillCellData ?? $nullCell);
    this.length = cols;
  }

  private _writableCombined(): {[index: number]: string} {
    if (this._combined === EMPTY_COMBINED) {
      this._combined = {};
    }
    return this._combined;
  }

  private _writableExtendedAttrs(): {[index: number]: IExtendedAttrs | undefined} {
    return this._extendedAttrs ??= {};
  }

  /**
   * Fill cells `[start, end)` with `cell`. Equivalent to calling `setCell` for
   * each index, but interns the style once and uses typed array fills.
   */
  private _fillRange(start: number, end: number, cell: ICellData): void {
    if (start >= end) {
      return;
    }
    if (cell.content & Content.IS_COMBINED_MASK) {
      const combined = this._writableCombined();
      for (let i = start; i < end; i++) {
        combined[i] = cell.combinedData;
      }
    }
    if (cell.bg & BgFlags.HAS_EXTENDED) {
      if (cell.extended === SINGLE_UNDERLINE_ATTRS) {
        if (this._extendedAttrs) {
          for (let i = start; i < end; i++) delete this._extendedAttrs[i];
        }
      } else {
        const extendedAttrs = this._writableExtendedAttrs();
        for (let i = start; i < end; i++) {
          extendedAttrs[i] = cell.extended;
        }
      }
    }
    // Intern before filling: a compaction inside renumbers existing ids.
    const styleId = this._internStyle(cell.fg, cell.bg);
    this._content.fill(cell.content, start, end);
    this._styleIds.fill(styleId, start, end);
  }

  /**
   * Move `length` cells within this line from `src` to `dest`. The style table
   * is shared, so ids move verbatim; sparse entries follow their flags.
   */
  private _moveCells(src: number, dest: number, length: number): void {
    if (length <= 0 || src === dest) {
      return;
    }
    const combined = this._combined !== EMPTY_COMBINED ? this._combined : undefined;
    const extendedAttrs = this._extendedAttrs;
    if (combined || extendedAttrs) {
      // Iterate so every source is read before it can be overwritten.
      const reverse = dest > src;
      for (let i = 0; i < length; i++) {
        const offset = reverse ? length - 1 - i : i;
        const s = src + offset;
        const d = dest + offset;
        if (combined && (this._content[s] & Content.IS_COMBINED_MASK)) {
          combined[d] = combined[s];
        }
        if (extendedAttrs && (this._styleBg[this._styleIds[s]] & BgFlags.HAS_EXTENDED)) {
          extendedAttrs[d] = extendedAttrs[s];
        }
      }
    }
    this._content.copyWithin(dest, src, src + length);
    this._styleIds.copyWithin(dest, src, src + length);
  }

  /** Invalidate state derived from style ids after they are renumbered or replaced. */
  private _resetStyleCache(): void {
    this._styleIndex = undefined;
    this._lastStyleId = -1;
  }

  /**
   * Intern an fg/bg pair into this line's style table and return its id.
   * Id 0 is implicit (fg = 0, bg = 0), so the default case is a single compare
   * and never grows the table. Reclaim obsolete styles periodically during repainting.
   */
  private _internStyle(fg: number, bg: number): number {
    // Preserve the unsigned-word semantics of the original Uint32Array storage.
    fg >>>= 0;
    bg >>>= 0;
    if (fg === 0 && bg === 0) {
      return Constants.DEFAULT_STYLE_ID;
    }
    if (this._lastStyleId !== -1 && this._lastStyleFg === fg && this._lastStyleBg === bg) {
      return this._lastStyleId;
    }
    const id = this._lookupOrAddStyle(fg, bg);
    this._lastStyleId = id;
    this._lastStyleFg = fg;
    this._lastStyleBg = bg;
    return id;
  }

  private _lookupOrAddStyle(fg: number, bg: number): number {
    let fgs = this._styleFg;
    let bgs = this._styleBg;
    // Consecutive writes commonly use the most recently added style.
    const last = fgs.length - 1;
    if (fgs[last] === fg && bgs[last] === bg) {
      return last;
    }
    if (fgs.length > Constants.STYLE_INDEX_THRESHOLD) {
      const entry = (this._styleIndex ??= this._buildStyleIndex()).get(fg);
      const id = typeof entry === 'number'
        ? (bgs[entry] === bg ? entry : undefined)
        : entry?.get(bg);
      if (id !== undefined) {
        return id;
      }
    } else {
      for (let i = 1; i < fgs.length; i++) {
        if (fgs[i] === fg && bgs[i] === bg) {
          return i;
        }
      }
    }
    if (fgs.length >= Math.max(32, this._styleIds.length * 2) ||
        (fgs.length === 0x10000 && this._styleIds instanceof Uint16Array)) {
      this._compactStyles();
      fgs = this._styleFg;
      bgs = this._styleBg;
    }
    const id = fgs.length;
    if (id > 0xFFFF && this._styleIds instanceof Uint16Array) {
      // Extremely wide lines can have more live styles than a 16-bit id can represent.
      this._styleIds = new Uint32Array(this._styleIds);
    }
    fgs.push(fg);
    bgs.push(bg);
    this._indexStyle(fg, bg, id);
    return id;
  }

  /** Keep the lazy hash index in step with an appended style. */
  private _indexStyle(fg: number, bg: number, id: number): void {
    if (this._styleIndex) {
      const entry = this._styleIndex.get(fg);
      if (entry === undefined) {
        this._styleIndex.set(fg, id);
      } else if (typeof entry === 'number') {
        this._styleIndex.set(fg, new Map([[this._styleBg[entry], entry], [bg, id]]));
      } else {
        entry.set(bg, id);
      }
    } else if (this._styleFg.length > Constants.STYLE_INDEX_THRESHOLD) {
      this._styleIndex = this._buildStyleIndex();
    }
  }

  private _buildStyleIndex(): Map<number, number | Map<number, number>> {
    const index = new Map<number, number | Map<number, number>>();
    for (let i = 1; i < this._styleFg.length; i++) {
      const fg = this._styleFg[i];
      const entry = index.get(fg);
      if (entry === undefined) {
        index.set(fg, i);
      } else if (typeof entry === 'number') {
        index.set(fg, new Map([[this._styleBg[entry], entry], [this._styleBg[i], i]]));
      } else {
        entry.set(this._styleBg[i], i);
      }
    }
    return index;
  }

  private _compactStyles(): void {
    const fgs = [0];
    const bgs = [0];
    const remap = new Map<number, number>([[0, 0]]);
    for (let i = 0; i < this._styleIds.length; i++) {
      const oldId = this._styleIds[i];
      let id = remap.get(oldId);
      if (id === undefined) {
        id = fgs.length;
        remap.set(oldId, id);
        fgs.push(this._styleFg[oldId]);
        bgs.push(this._styleBg[oldId]);
      }
      this._styleIds[i] = id;
    }
    this._styleFg = fgs;
    this._styleBg = bgs;
    this._resetStyleCache();
  }

  /**
   * Get cell data CharData.
   * @deprecated
   */
  public get(index: number): CharData {
    const content = this._content[index];
    const cp = content & Content.CODEPOINT_MASK;
    return [
      this.getFg(index),
      (content & Content.IS_COMBINED_MASK)
        ? this._combined[index]
        : (cp) ? stringFromCodePoint(cp) : '',
      content >> Content.WIDTH_SHIFT,
      (content & Content.IS_COMBINED_MASK)
        ? this._combined[index].charCodeAt(this._combined[index].length - 1)
        : cp
    ];
  }

  /**
   * Set cell data from CharData.
   * @deprecated
   */
  public set(index: number, value: CharData): void {
    this._cacheValid = false;
    // The legacy CharData form carries only an fg attr; keep the cell's bg.
    const styleId = this._internStyle(value[CHAR_DATA_ATTR_INDEX], this.getBg(index));
    this._styleIds[index] = styleId;
    if (value[CHAR_DATA_CHAR_INDEX].length > 1) {
      this._writableCombined()[index] = value[1];
      this._content[index] = index | Content.IS_COMBINED_MASK | (value[CHAR_DATA_WIDTH_INDEX] << Content.WIDTH_SHIFT);
    } else {
      this._content[index] = value[CHAR_DATA_CHAR_INDEX].charCodeAt(0) | (value[CHAR_DATA_WIDTH_INDEX] << Content.WIDTH_SHIFT);
    }
  }

  /**
   * primitive getters
   * use these when only one value is needed, otherwise use `loadCell`
   */
  public getWidth(index: number): number {
    return this._content[index] >> Content.WIDTH_SHIFT;
  }

  /** Test whether content has width. */
  public hasWidth(index: number): number {
    return this._content[index] & Content.WIDTH_MASK;
  }

  /** Get FG cell component. */
  public getFg(index: number): number {
    return this._styleFg[this._styleIds[index]];
  }

  /** Get BG cell component. */
  public getBg(index: number): number {
    return this._styleBg[this._styleIds[index]];
  }

  /**
   * Test whether contains any chars.
   * Basically an empty has no content, but other cells might differ in FG/BG
   * from real empty cells.
   */
  public hasContent(index: number): number {
    return this._content[index] & Content.HAS_CONTENT_MASK;
  }

  /**
   * Get codepoint of the cell.
   * To be in line with `code` in CharData this either returns
   * a single UTF32 codepoint or the last codepoint of a combined string.
   */
  public getCodePoint(index: number): number {
    const content = this._content[index];
    if (content & Content.IS_COMBINED_MASK) {
      return this._combined[index].charCodeAt(this._combined[index].length - 1);
    }
    return content & Content.CODEPOINT_MASK;
  }

  /** Test whether the cell contains a combined string. */
  public isCombined(index: number): number {
    return this._content[index] & Content.IS_COMBINED_MASK;
  }

  /** Returns the string content of the cell. */
  public getString(index: number): string {
    const content = this._content[index];
    if (content & Content.IS_COMBINED_MASK) {
      return this._combined[index];
    }
    if (content & Content.CODEPOINT_MASK) {
      return stringFromCodePoint(content & Content.CODEPOINT_MASK);
    }
    // return empty string for empty cells
    return '';
  }

  /** Get state of protected flag. */
  public isProtected(index: number): number {
    return this.getBg(index) & BgFlags.PROTECTED;
  }

  /**
   * Load data at `index` into `cell`. This is used to access cells in a way that's more friendly
   * to GC as it significantly reduced the amount of new objects/references needed.
   */
  public loadCell(index: number, cell: ICellData): ICellData {
    cell.content = this._content[index];
    const styleId = this._styleIds[index];
    cell.fg = this._styleFg[styleId];
    cell.bg = this._styleBg[styleId];
    if (cell.content & Content.IS_COMBINED_MASK) {
      cell.combinedData = this._combined[index];
    } else {
      cell.combinedData = '';
    }
    cell.extended = this.getExtended(index);
    return cell;
  }

  /**
   * Convenience wrapper around loadCell, used by public API.
   */
  public getCell(x: number, cell?: ICellData): ICellData | undefined {
    if (x < 0 || x >= this.length) {
      return undefined;
    }

    if (cell) {
      this.loadCell(x, cell);
      return cell;
    }
    return this.loadCell(x, new CellData());
  }

  public getExtended(index: number): IExtendedAttrs {
    if (this._styleBg[this._styleIds[index]] & BgFlags.HAS_EXTENDED) {
      const extended = this._extendedAttrs?.[index];
      if (extended) {
        return extended;
      }
      // HAS_EXTENDED is retained for ordinary single underline so consumers
      // see exactly the same flags/style/color as before, without a side-map slot.
      return SINGLE_UNDERLINE_ATTRS;
    }
    // Do not mutate cell.extended in place: it may still reference this line's map entry from a
    // prior loadCell into a reused CellData.
    // We use $extended as blueprint and reset the internals
    // mimicking the ctor to avoid a new allocation.
    $extended._ext = 0;
    $extended._urlId = 0;
    $extended.payload = undefined;
    return $extended;
  }

  /**
   * Set data at `index` to `cell`.
   */
  public setCell(index: number, cell: ICellData): void {
    this._cacheValid = false;
    if (cell.content & Content.IS_COMBINED_MASK) {
      this._writableCombined()[index] = cell.combinedData;
    }
    if (cell.bg & BgFlags.HAS_EXTENDED) {
      if (cell.extended === SINGLE_UNDERLINE_ATTRS) {
        if (this._extendedAttrs) delete this._extendedAttrs[index];
      } else {
        this._writableExtendedAttrs()[index] = cell.extended;
      }
    }
    this._content[index] = cell.content;
    const styleId = this._internStyle(cell.fg, cell.bg);
    this._styleIds[index] = styleId;
  }

  /**
   * Set cell data from input handler.
   * Since the input handler see the incoming chars as UTF32 codepoints,
   * it gets an optimized access method.
   */
  public setCellFromCodepoint(index: number, codePoint: number, width: number, attrs: IAttributeData): void {
    this._cacheValid = false;
    if (attrs.bg & BgFlags.HAS_EXTENDED) {
      if (attrs.extended === SINGLE_UNDERLINE_ATTRS) {
        if (this._extendedAttrs) delete this._extendedAttrs[index];
      } else {
        this._writableExtendedAttrs()[index] = attrs.extended;
      }
    }
    this._content[index] = codePoint | (width << Content.WIDTH_SHIFT);
    const styleId = this._internStyle(attrs.fg, attrs.bg);
    this._styleIds[index] = styleId;
  }

  /**
   * Add a codepoint to a cell from input handler.
   * During input stage combining chars with a width of 0 follow and stack
   * onto a leading char. Since we already set the attrs
   * by the previous `setDataFromCodePoint` call, we can omit it here.
   */
  public addCodepointToCell(index: number, codePoint: number, width: number): void {
    this._cacheValid = false;
    let content = this._content[index];
    if (content & Content.IS_COMBINED_MASK) {
      // we already have a combined string, simply add
      this._writableCombined()[index] += stringFromCodePoint(codePoint);
    } else {
      if (content & Content.CODEPOINT_MASK) {
        // normal case for combining chars:
        //  - move current leading char + new one into combined string
        //  - set combined flag
        this._writableCombined()[index] = stringFromCodePoint(content & Content.CODEPOINT_MASK) + stringFromCodePoint(codePoint);
        content &= ~Content.CODEPOINT_MASK; // set codepoint in buffer to 0
        content |= Content.IS_COMBINED_MASK;
      } else {
        // should not happen - we actually have no data in the cell yet
        // simply set the data in the cell buffer with a width of 1
        content = codePoint | (1 << Content.WIDTH_SHIFT);
      }
    }
    if (width) {
      content &= ~Content.WIDTH_MASK;
      content |= width << Content.WIDTH_SHIFT;
    }
    this._content[index] = content;
  }

  public insertCells(pos: number, n: number, fillCellData: ICellData): void {
    this._cacheValid = false;
    pos %= this.length;

    // handle fullwidth at pos: reset cell one to the left if pos is second cell of a wide char
    if (pos && this.getWidth(pos - 1) === 2) {
      this.setCellFromCodepoint(pos - 1, 0, 1, fillCellData);
    }

    if (n < this.length - pos) {
      this._moveCells(pos, pos + n, this.length - pos - n);
      this._fillRange(pos, pos + n, fillCellData);
    } else {
      this._fillRange(pos, this.length, fillCellData);
    }

    // handle fullwidth at line end: reset last cell if it is first cell of a wide char
    if (this.getWidth(this.length - 1) === 2) {
      this.setCellFromCodepoint(this.length - 1, 0, 1, fillCellData);
    }
  }

  public deleteCells(pos: number, n: number, fillCellData: ICellData): void {
    this._cacheValid = false;
    pos %= this.length;
    if (n < this.length - pos) {
      this._moveCells(pos + n, pos, this.length - pos - n);
      this._fillRange(this.length - n, this.length, fillCellData);
    } else {
      this._fillRange(pos, this.length, fillCellData);
    }

    // handle fullwidth at pos:
    // - reset pos-1 if wide char
    // - reset pos if width==0 (previous second cell of a wide char)
    if (pos && this.getWidth(pos - 1) === 2) {
      this.setCellFromCodepoint(pos - 1, 0, 1, fillCellData);
    }
    if (this.getWidth(pos) === 0 && !this.hasContent(pos)) {
      this.setCellFromCodepoint(pos, 0, 1, fillCellData);
    }
  }

  public replaceCells(start: number, end: number, fillCellData: ICellData, respectProtect: boolean = false): void {
    this._cacheValid = false;
    // full branching on respectProtect==true, hopefully getting fast JIT for standard case
    if (respectProtect) {
      if (start && this.getWidth(start - 1) === 2 && !this.isProtected(start - 1)) {
        this.setCellFromCodepoint(start - 1, 0, 1, fillCellData);
      }
      if (end < this.length && this.getWidth(end - 1) === 2 && !this.isProtected(end)) {
        this.setCellFromCodepoint(end, 0, 1, fillCellData);
      }
      while (start < end  && start < this.length) {
        if (!this.isProtected(start)) {
          this.setCell(start, fillCellData);
        }
        start++;
      }
      return;
    }

    // handle fullwidth at start: reset cell one to the left if start is second cell of a wide char
    if (start && this.getWidth(start - 1) === 2) {
      this.setCellFromCodepoint(start - 1, 0, 1, fillCellData);
    }
    // handle fullwidth at last cell + 1: reset to empty cell if it is second part of a wide char
    if (end < this.length && this.getWidth(end - 1) === 2) {
      this.setCellFromCodepoint(end, 0, 1, fillCellData);
    }

    this._fillRange(start, Math.min(end, this.length), fillCellData);
  }

  /**
   * Resize BufferLine to `cols` filling excess cells with `fillCellData`.
   * The underlying array buffer will not change if there is still enough space
   * to hold the new buffer line data.
   * Returns a boolean indicating, whether a `cleanupMemory` call would free
   * excess memory (true after shrinking > Constants.CLEANUP_THRESHOLD).
   */
  public resize(cols: number, fillCellData: ICellData): boolean {
    this._cacheValid = false;
    if (cols === this.length) {
      return this._content.length * 4 * Constants.CLEANUP_THRESHOLD < this._content.buffer.byteLength;
    }
    if (cols > this.length) {
      if (this._content.buffer.byteLength >= cols * 4) {
        // optimization: avoid alloc and data copy if buffer has enough room
        this._content = new Uint32Array(this._content.buffer, 0, cols);
      } else {
        // slow path: new alloc and full data copy
        const content = new Uint32Array(cols);
        content.set(this._content);
        this._content = content;
      }
      const styleIdsConstructor = this._styleIds instanceof Uint16Array ? Uint16Array : Uint32Array;
      if (this._styleIds.buffer.byteLength >= cols * styleIdsConstructor.BYTES_PER_ELEMENT) {
        this._styleIds = new styleIdsConstructor(this._styleIds.buffer, 0, cols);
      } else {
        const styleIds = new styleIdsConstructor(cols);
        styleIds.set(this._styleIds);
        this._styleIds = styleIds;
      }
      this._fillRange(this.length, cols, fillCellData);
    } else {
      // optimization: just shrink the view on existing buffer
      this._content = this._content.subarray(0, cols);
      this._styleIds = this._styleIds.subarray(0, cols);
      if (this._styleFg.length > Math.max(32, cols * 2)) {
        this._compactStyles();
      }
      // Remove any cut off combined data
      if (this._combined !== EMPTY_COMBINED) {
        const keys = Object.keys(this._combined);
        for (let i = 0; i < keys.length; i++) {
          const key = parseInt(keys[i], 10);
          if (key >= cols) {
            delete this._combined[key];
          }
        }
      }
      // remove any cut off extended attributes
      if (this._extendedAttrs) {
        const extKeys = Object.keys(this._extendedAttrs);
        for (let i = 0; i < extKeys.length; i++) {
          const key = parseInt(extKeys[i], 10);
          if (key >= cols) {
            delete this._extendedAttrs[key];
          }
        }
      }
    }
    this.length = cols;
    return cols * 4 * Constants.CLEANUP_THRESHOLD < this._content.buffer.byteLength;
  }

  /**
   * Cleanup underlying array buffer.
   * A cleanup will be triggered if the array buffer exceeds the actual used
   * memory by a factor of Constants.CLEANUP_THRESHOLD.
   * Returns 0 or 1 indicating whether a cleanup happened.
   */
  public cleanupMemory(): number {
    let cleaned = 0;
    if (this._content.length * 4 * Constants.CLEANUP_THRESHOLD < this._content.buffer.byteLength) {
      const content = new Uint32Array(this._content.length);
      content.set(this._content);
      this._content = content;
      cleaned = 1;
    }
    if (this._styleIds.byteLength * Constants.CLEANUP_THRESHOLD < this._styleIds.buffer.byteLength) {
      this._styleIds = this._styleIds.slice();
      cleaned = 1;
    }
    return cleaned;
  }

  /** fill a line with fillCharData */
  public fill(fillCellData: ICellData, respectProtect: boolean = false): void {
    this._cacheValid = false;
    // full branching on respectProtect==true, hopefully getting fast JIT for standard case
    if (respectProtect) {
      for (let i = 0; i < this.length; ++i) {
        if (!this.isProtected(i)) {
          this.setCell(i, fillCellData);
        }
      }
      return;
    }
    this._combined = EMPTY_COMBINED;
    this._extendedAttrs = undefined;
    this._resetStyleTable();
    this._fillRange(0, this.length, fillCellData);
  }

  /** Reset to the implicit default-only style table, reusing its arrays. */
  private _resetStyleTable(): void {
    // Style tables are never shared between lines, so truncating in place is
    // safe. Assigning `length` is a slow builtin, so skip it when already reset.
    if (this._styleFg.length !== 1) {
      this._styleFg.length = 1;
      this._styleBg.length = 1;
    }
    this._resetStyleCache();
  }

  /** alter to a full copy of line  */
  public copyFrom(line: BufferLine, blank?: boolean): void {
    if (line === this) {
      return;
    }
    if (this.length !== line.length) {
      this._content = new Uint32Array(line._content);
      this._styleIds = line._styleIds.slice();
    } else {
      // use high speed copy if lengths are equal
      this._content.set(line._content);
      if (this._styleIds.BYTES_PER_ELEMENT < line._styleIds.BYTES_PER_ELEMENT) {
        this._styleIds = line._styleIds.slice();
      } else {
        this._styleIds.set(line._styleIds);
      }
    }
    this._copyStyleTableFrom(line);
    this.length = line.length;
    if (blank) {
      // a blank line may never hold combined or extended attrs,
      // thus we can skip handling them
      this._combined = EMPTY_COMBINED;
      this._extendedAttrs = undefined;
    } else {
      this._copySparseMapsFrom(line);
    }
    this._cache = '';
    this._cacheValid = false;
    this.isWrapped = line.isWrapped;
  }

  /** create a new clone */
  public clone(blank?: boolean): IBufferLine {
    const newLine = new BufferLine(0, undefined, false);
    newLine._content = new Uint32Array(this._content);
    newLine._styleIds = this._styleIds.slice();
    if (this._styleFg.length > 1) {
      newLine._styleFg = this._styleFg.slice();
      newLine._styleBg = this._styleBg.slice();
    }
    newLine.length = this.length;
    if (!blank) {
      // a blank line may never hold combined or extended attrs,
      // thus we can skip handling them
      newLine._copySparseMapsFrom(this);
    }
    newLine.isWrapped = this.isWrapped;
    return newLine;
  }

  public getTrimmedLength(): number {
    for (let i = this.length - 1; i >= 0; --i) {
      if ((this._content[i] & Content.HAS_CONTENT_MASK)) {
        return i + (this._content[i] >> Content.WIDTH_SHIFT);
      }
    }
    return 0;
  }

  public getNoBgTrimmedLength(): number {
    for (let i = this.length - 1; i >= 0; --i) {
      if ((this._content[i] & Content.HAS_CONTENT_MASK) || (this.getBg(i) & Attributes.CM_MASK)) {
        return i + (this._content[i] >> Content.WIDTH_SHIFT);
      }
    }
    return 0;
  }

  public copyCellsFrom(src: BufferLine, srcCol: number, destCol: number, length: number, applyInReverse: boolean): void {
    this._cacheValid = false;
    const content = this._content;
    const srcContent = src._content;
    const srcStyleIds = src._styleIds;
    const srcFg = src._styleFg;
    const srcBg = src._styleBg;
    // Destination and source have independent interned style tables, so source
    // style ids must be remapped. Distinct source ids are remapped once per call.
    let remap: Map<number, number> | undefined;
    let destFg = this._styleFg;
    const remapStyle = (srcId: number): number => {
      if (src === this) {
        return srcId;
      }
      if (srcId === Constants.DEFAULT_STYLE_ID) {
        return Constants.DEFAULT_STYLE_ID;
      }
      remap ??= new Map<number, number>();
      let destId = remap.get(srcId);
      if (destId === undefined) {
        destId = this._internStyle(srcFg[srcId], srcBg[srcId]);
        if (destFg !== this._styleFg) {
          // Compaction renumbers destination ids, including any cached mappings.
          remap.clear();
          destFg = this._styleFg;
        }
        remap.set(srcId, destId);
      }
      return destId;
    };
    if (applyInReverse) {
      for (let cell = length - 1; cell >= 0; cell--) {
        const s = srcCol + cell;
        const d = destCol + cell;
        content[d] = srcContent[s];
        const styleId = remapStyle(srcStyleIds[s]);
        this._styleIds[d] = styleId;
        this._copyCellMapsFrom(src, s, d);
      }
    } else {
      for (let cell = 0; cell < length; cell++) {
        const s = srcCol + cell;
        const d = destCol + cell;
        content[d] = srcContent[s];
        const styleId = remapStyle(srcStyleIds[s]);
        this._styleIds[d] = styleId;
        this._copyCellMapsFrom(src, s, d);
      }
    }
  }

  /**
   * Translates the buffer line to a string. Caching only applies to canonical full-line translation
   * requests (regardless of `trimRight` value).
   *
   * @param trimRight Whether to trim any empty cells on the right.
   * @param startCol The column to start the string (0-based inclusive).
   * @param endCol The column to end the string (0-based exclusive).
   * @param outColumns if specified, this array will be filled with column numbers such that
   * `returnedString[i]` is displayed at `outColumns[i]` column. `outColumns[returnedString.length]`
   * is where the character following `returnedString` will be displayed.
   *
   * When a single cell is translated to multiple UTF-16 code units (e.g. surrogate pair) in the
   * returned string, the corresponding entries in `outColumns` will have the same column number.
   */
  public translateToString(trimRight?: boolean, startCol?: number, endCol?: number, outColumns?: number[]): string {
    const isCanonical = (startCol === undefined || startCol === 0) && endCol === undefined && outColumns === undefined;
    if (isCanonical && this._cacheValid) {
      if (trimRight) {
        return this._cacheTrimmed ? this._cache : this._cache.trimEnd();
      }
      if (!this._cacheTrimmed) {
        return this._cache;
      }
    }
    startCol = startCol ?? 0;
    endCol = endCol ?? this.length;
    if (trimRight) {
      endCol = Math.min(endCol, this.getTrimmedLength());
    }
    if (outColumns) {
      outColumns.length = 0;
    }
    const cellContents: string[] = [];
    while (startCol < endCol) {
      const content = this._content[startCol];
      const cp = content & Content.CODEPOINT_MASK;
      const chars = (content & Content.IS_COMBINED_MASK) ? this._combined[startCol] : (cp) ? stringFromCodePoint(cp) : WHITESPACE_CELL_CHAR;
      cellContents.push(chars);
      if (outColumns) {
        for (let i = 0; i < chars.length; ++i) {
          outColumns.push(startCol);
        }
      }
      startCol += (content >> Content.WIDTH_SHIFT) || 1; // always advance by at least 1
    }
    if (outColumns) {
      outColumns.push(startCol);
    }
    const result = cellContents.join('');
    if (isCanonical) {
      this._cache = result;
      this._cacheValid = true;
      this._cacheTrimmed = !!trimRight;
    }
    return result;
  }

  /** Copy the source line's interned style table so ids stay valid. */
  private _copyStyleTableFrom(line: BufferLine): void {
    if (line._styleFg.length <= 1) {
      this._resetStyleTable();
      return;
    }
    this._styleFg = line._styleFg.slice();
    this._styleBg = line._styleBg.slice();
    this._resetStyleCache();
  }

  /** Copy sparse map entries for a single cell when `_content`/bg flags require them. */
  private _copyCellMapsFrom(src: BufferLine, srcCol: number, destCol: number): void {
    if (src._content[srcCol] & Content.IS_COMBINED_MASK) {
      this._writableCombined()[destCol] = src._combined[srcCol];
    }
    if (src._styleBg[src._styleIds[srcCol]] & BgFlags.HAS_EXTENDED) {
      const extended = src._extendedAttrs?.[srcCol];
      if (extended) {
        this._writableExtendedAttrs()[destCol] = extended;
      } else if (this._extendedAttrs) {
        delete this._extendedAttrs[destCol];
      }
    }
  }

  /**
   * Rebuild sparse maps from another line. Only the source's existing keys are
   * visited (not every column), and entries whose cell flag is no longer set are
   * dropped, so stale data never propagates.
   */
  private _copySparseMapsFrom(line: BufferLine): void {
    this._combined = EMPTY_COMBINED;
    this._extendedAttrs = undefined;
    const srcCombined = line._combined;
    if (srcCombined !== EMPTY_COMBINED) {
      for (const key in srcCombined) {
        const i = +key;
        if (i < line.length && (line._content[i] & Content.IS_COMBINED_MASK)) {
          this._writableCombined()[i] = srcCombined[i];
        }
      }
    }
    const srcExtendedAttrs = line._extendedAttrs;
    if (srcExtendedAttrs) {
      for (const key in srcExtendedAttrs) {
        const i = +key;
        if (i < line.length && srcExtendedAttrs[i] && (line._styleBg[line._styleIds[i]] & BgFlags.HAS_EXTENDED)) {
          this._writableExtendedAttrs()[i] = srcExtendedAttrs[i];
        }
      }
    }
  }
}
