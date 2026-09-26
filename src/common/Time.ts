/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

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
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
