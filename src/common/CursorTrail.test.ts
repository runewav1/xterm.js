/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { css } from './Color';
import { resolveCursorTrailOptions, sanitizeCursorTrail, sanitizeCursorTrailColor, sanitizeCursorTrailDecay, sanitizeCursorTrailStartThreshold } from './CursorTrail';

describe('CursorTrail options', () => {
  it('sanitizes the stationary threshold', () => {
    assert.strictEqual(sanitizeCursorTrail(250.9), 250);
    assert.strictEqual(sanitizeCursorTrail(0), 0);
    assert.strictEqual(sanitizeCursorTrail(-10), 0);
    assert.strictEqual(sanitizeCursorTrail(NaN), 0);
    assert.strictEqual(sanitizeCursorTrail(Infinity), 0);
    // No arbitrary upper cap.
    assert.strictEqual(sanitizeCursorTrail(10_000_000), 10_000_000);
  });

  it('sanitizes decay pairs and lifts slow to fast', () => {
    assert.deepEqual(sanitizeCursorTrailDecay([0.2, 0.5]), [0.2, 0.5]);
    assert.deepEqual(sanitizeCursorTrailDecay([0.5, 0.2]), [0.5, 0.5]);
    assert.deepEqual(sanitizeCursorTrailDecay([0, 0]), [0, 0]);
    assert.deepEqual(sanitizeCursorTrailDecay([NaN, Infinity]), [0.1, 0.4]);
    assert.deepEqual(sanitizeCursorTrailDecay('nonsense'), [0.1, 0.4]);
  });

  it('sanitizes the start threshold', () => {
    assert.deepEqual(sanitizeCursorTrailStartThreshold(3), [3, 3]);
    assert.deepEqual(sanitizeCursorTrailStartThreshold([1, 4]), [1, 4]);
    assert.deepEqual(sanitizeCursorTrailStartThreshold([-1, NaN]), [0, 2]);
    assert.deepEqual(sanitizeCursorTrailStartThreshold(undefined), [2, 2]);
  });

  it('validates the color override', () => {
    assert.strictEqual(sanitizeCursorTrailColor('none'), 'none');
    assert.strictEqual(sanitizeCursorTrailColor(undefined), 'none');
    assert.strictEqual(sanitizeCursorTrailColor('#ff0000'), '#ff0000');
    assert.throws(() => sanitizeCursorTrailColor('not-a-color'), 'cursorTrailColor');
    assert.throws(() => sanitizeCursorTrailColor(42), 'cursorTrailColor');
  });

  it('resolves raw options into the hot-path shape', () => {
    const resolved = resolveCursorTrailOptions({ cursorTrail: 120, cursorTrailDecay: [0.05, 0.2], cursorTrailStartThreshold: [1, 2], cursorTrailColor: '#336699' });
    assert.strictEqual(resolved.stationaryMs, 120);
    assert.strictEqual(resolved.decayFast, 0.05);
    assert.strictEqual(resolved.decaySlow, 0.2);
    assert.strictEqual(resolved.thresholdX, 1);
    assert.strictEqual(resolved.thresholdY, 2);
    assert.strictEqual(resolved.colorRgba, css.toColor('#336699').rgba);
  });

  it('falls back to the theme color when none is given', () => {
    const resolved = resolveCursorTrailOptions({ cursorTrail: 120 });
    assert.isUndefined(resolved.colorRgba);
    assert.strictEqual(resolved.stationaryMs, 120);
    assert.strictEqual(resolved.decayFast, 0.1);
    assert.strictEqual(resolved.decaySlow, 0.4);
    assert.strictEqual(resolved.thresholdX, 2);
    assert.strictEqual(resolved.thresholdY, 2);
  });
});
