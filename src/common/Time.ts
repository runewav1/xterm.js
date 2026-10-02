/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// Clock availability is fixed for a terminal runtime. Resolve and bind once:
// repeatedly looking up the browser's global Performance object is expensive
// when an input stream explicitly positions the cursor before every character.
const getTimestamp = createMonotonicClock(typeof performance === 'undefined' ? undefined : performance);

export function createMonotonicClock(clock?: Pick<Performance, 'now'>): () => number {
  return typeof clock?.now === 'function' ? clock.now.bind(clock) : Date.now;
}

/**
 * Returns a monotonically increasing timestamp in milliseconds. `performance.now`
 * is preferred because it is not affected by wall-clock adjustments; `Date.now`
 * is the fallback for environments that do not expose the Performance API.
 *
 * Both the parser (which records when the client last explicitly positioned the
 * cursor) and the GPU trail animation use this clock so the two timestamps are
 * directly comparable.
 */
export function monotonicNow(): number {
  return getTimestamp();
}
