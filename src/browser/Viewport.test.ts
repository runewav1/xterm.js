/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { Viewport } from './Viewport';
import { Emitter } from '../common/Event';

// Exercise scheduling/scroll state without constructing DOM scrollbars. The
// scroll-position setter emits the same synchronous feedback as Scrollable.
function fixture(): any {
  const viewport = Object.create(Viewport.prototype) as Viewport;
  const internal = viewport as any;
  const buffer = { ydisp: 0, lines: { length: 10040 } };
  const core = { decPrivateModes: { synchronizedOutput: false } };
  const frames: FrameRequestCallback[] = [];
  const dimensions: { height: number, scrollHeight: number }[] = [];
  const positions: number[] = [];
  let scrollTop = 0;
  internal._bufferService = { buffer };
  internal._coreService = core;
  internal._renderService = {
    dimensions: { css: { cell: { height: 10 }, canvas: { height: 400 } } },
    addRefreshCallback(callback: FrameRequestCallback): number {
      frames.push(callback);
      return 1;
    }
  };
  internal._onRequestScrollLines = new Emitter<number>();
  internal._onRequestScrollLines.event((delta: number) => { buffer.ydisp += delta; });
  internal._scrollableElement = {
    getScrollPosition: () => ({ scrollTop }),
    setScrollDimensions(value: { height: number, scrollHeight: number }): void { dimensions.push(value); },
    setScrollPosition(value: { scrollTop: number }): void {
      scrollTop = value.scrollTop;
      positions.push(scrollTop);
      internal._handleScroll({ scrollTop });
    }
  };
  return {
    viewport, internal, buffer, core, dimensions, positions,
    pendingFrames: () => frames.length,
    scrollTop: () => scrollTop,
    flushFrame: () => {
      for (const callback of frames.splice(0)) callback(0);
    }
  };
}

describe('Viewport deferred sync', () => {
  it('coalesces output updates and applies the latest position to the scrollbar', () => {
    const f = fixture();
    for (let row = 1; row <= 5000; row++) {
      f.buffer.ydisp = row;
      f.viewport.queueSync(row);
    }
    assert.equal(f.pendingFrames(), 1);
    assert.equal(f.dimensions.length, 0);
    f.flushFrame();
    assert.equal(f.dimensions.length, 1);
    assert.equal(f.scrollTop(), 50000);
    assert.equal(f.buffer.ydisp, 5000);
  });

  it('flushes pending output before relative wheel scrolling without undoing user input', () => {
    const f = fixture();
    f.buffer.ydisp = 100;
    f.viewport.queueSync(100);
    f.viewport.scrollLines(-3);
    assert.equal(f.buffer.ydisp, 97);
    assert.equal(f.scrollTop(), 970);
    f.flushFrame();
    assert.equal(f.buffer.ydisp, 97);
    assert.equal(f.scrollTop(), 970);
  });

  it('does not overwrite an explicit scrollToLine with an older output update', () => {
    const f = fixture();
    f.buffer.ydisp = 100;
    f.viewport.queueSync(100);
    f.viewport.scrollToLine(20, true);
    f.flushFrame();
    assert.equal(f.buffer.ydisp, 20);
    assert.equal(f.scrollTop(), 200);
  });

  it('uses the new buffer position when resize/reflow queues a sync without a target', () => {
    const f = fixture();
    f.buffer.ydisp = 100;
    f.viewport.queueSync(100);
    f.buffer.ydisp = 60;
    f.viewport.queueSync();
    f.flushFrame();
    assert.equal(f.buffer.ydisp, 60);
    assert.equal(f.scrollTop(), 600);
  });

  it('defers synchronized output without scheduling intermediate frames', () => {
    const f = fixture();
    f.core.decPrivateModes.synchronizedOutput = true;
    f.buffer.ydisp = 10;
    f.viewport.queueSync(10);
    f.buffer.ydisp = 20;
    f.viewport.queueSync(20);
    assert.equal(f.pendingFrames(), 0);
    assert.equal(f.dimensions.length, 0);
    f.core.decPrivateModes.synchronizedOutput = false;
    f.internal._syncOnRender();
    assert.equal(f.scrollTop(), 200);
    assert.isFalse(f.internal._needsSyncOnRender);
  });
});

describe('Viewport sub-row pixel offset', () => {
  // Minimal viewport exercising only _handleScroll/_applyPixelOffset, with a
  // screen element whose transform writes are counted.
  function offsetFixture(dpr: number): any {
    const viewport = Object.create(Viewport.prototype) as Viewport;
    const internal = viewport as any;
    const buffer = { ydisp: 0, lines: { length: 1000 } };
    let transform = '';
    let writes = 0;
    const style: any = {};
    Object.defineProperty(style, 'transform', {
      get: () => transform,
      set: (value: string) => { transform = value; writes++; }
    });
    const screenElement = {
      style,
      ownerDocument: { defaultView: { devicePixelRatio: dpr } }
    };
    internal._bufferService = { buffer };
    internal._coreService = { decPrivateModes: { synchronizedOutput: false } };
    internal._renderService = {
      dimensions: { css: { cell: { height: 10 }, canvas: { height: 400 } } }
    };
    internal._screenElement = screenElement;
    internal._pixelOffset = 0;
    internal._appliedPixelOffset = 0;
    internal._onRequestScrollLines = new Emitter<number>();
    internal._onRequestScrollLines.event((delta: number) => { buffer.ydisp += delta; });
    return {
      buffer,
      transform: () => transform,
      writes: () => writes,
      handleScroll: (scrollTop: number) => internal._handleScroll({ scrollTop })
    };
  }

  it('applies the sub-row offset as a device-pixel-rounded translate', () => {
    const f = offsetFixture(1);
    // newRow = round(15/10) = 2, offset = 20 - 15 = 5
    f.handleScroll(15);
    assert.equal(f.transform(), 'translateY(5px)');
  });

  it('rounds the offset to whole device pixels', () => {
    const f = offsetFixture(2);
    // newRow = 2, offset = 2.5 -> round(5)/2 = 2.5
    f.handleScroll(17.5);
    assert.equal(f.transform(), 'translateY(2.5px)');
  });

  it('does not rewrite the transform for an unchanged rounded offset', () => {
    const f = offsetFixture(2);
    f.handleScroll(17.4); // offset 2.6 -> rounds to 2.5
    assert.equal(f.writes(), 1);
    f.handleScroll(17.5); // offset 2.5 -> same rounded value
    assert.equal(f.writes(), 1);
    assert.equal(f.transform(), 'translateY(2.5px)');
  });

  it('clears the transform when the viewport returns to a row-aligned position', () => {
    const f = offsetFixture(2);
    f.handleScroll(17.5);
    assert.equal(f.transform(), 'translateY(2.5px)');
    f.handleScroll(20); // offset 0
    assert.equal(f.transform(), '');
    assert.equal(f.writes(), 2);
  });
});
