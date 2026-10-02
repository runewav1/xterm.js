/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { createMonotonicClock, monotonicNow } from './Time';

describe('monotonic clock', () => {
  it('binds the Performance receiver and resolves host getters only during creation', () => {
    let timestamp = 10;
    let methodReads = 0;
    const performanceValue = {
      get now(): () => number {
        methodReads++;
        return function (this: unknown): number {
          assert.strictEqual(this, performanceValue);
          return timestamp++;
        };
      }
    };
    const clock = createMonotonicClock(performanceValue);
    const initialMethodReads = methodReads;
    assert.isAbove(initialMethodReads, 0);
    for (let i = 0; i < 20; i++) {
      assert.equal(clock(), 10 + i);
    }
    assert.equal(methodReads, initialMethodReads);
  });

  it('uses Date.now when Performance is unavailable', () => {
    const clock = createMonotonicClock();
    const before = Date.now();
    const timestamp = clock();
    assert.isAtLeast(timestamp, before);
    assert.isAtMost(timestamp, Date.now());
  });

  it('uses Date.now when Performance has no now method', () => {
    const clock = createMonotonicClock({} as Performance);
    const before = Date.now();
    const timestamp = clock();
    assert.isAtLeast(timestamp, before);
    assert.isAtMost(timestamp, Date.now());
  });

  it('keeps the runtime clock nondecreasing', () => {
    const before = monotonicNow();
    assert.isAtLeast(monotonicNow(), before);
  });
});
