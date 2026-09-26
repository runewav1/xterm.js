/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { css } from './Color';

/**
 * Default cursor trail decay times in seconds, `[fast, slow]`. These mirror
 * kitty's `cursor_trail_decay = 0.1 0.4` default.
 */
export const DEFAULT_CURSOR_TRAIL_DECAY: readonly [number, number] = [0.1, 0.4];

/**
 * Default cursor trail start threshold in cells, `[x, y]`. Mirrors kitty's
 * `cursor_trail_start_threshold = 2`.
 */
export const DEFAULT_CURSOR_TRAIL_START_THRESHOLD: readonly [number, number] = [2, 2];

/**
 * The text used for `cursorTrailColor` when the trail should use the theme's
 * cursor color instead of an explicit override.
 */
export const CURSOR_TRAIL_COLOR_NONE = 'none';

/**
 * Fully resolved cursor trail options. Every field is present and safe to use
 * on the animation hot path; `colorRgba` has already been parsed.
 */
export interface IResolvedCursorTrailOptions {
  /**
   * Milliseconds the cursor must remain stationary before the trail follows it.
   * Zero disables the trail. This maps to kitty's `cursor_trail`.
   */
  stationaryMs: number;
  /** Fast decay time in seconds. Maps to the first value of `cursor_trail_decay`. */
  decayFast: number;
  /** Slow decay time in seconds. Maps to the second value of `cursor_trail_decay`. */
  decaySlow: number;
  /** Horizontal start threshold in cells. Maps to `cursor_trail_start_threshold` x. */
  thresholdX: number;
  /** Vertical start threshold in cells. Maps to `cursor_trail_start_threshold` y. */
  thresholdY: number;
  /** Parsed override color, or undefined to use the theme's cursor color. */
  colorRgba: number | undefined;
}

/** Raw option shape consumed by {@link resolveCursorTrailOptions}. */
export interface ICursorTrailRawOptions {
  cursorTrail?: unknown;
  cursorTrailDecay?: unknown;
  cursorTrailStartThreshold?: unknown;
  cursorTrailColor?: unknown;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampNonNegative(value: unknown, fallback: number): number {
  const number = toFiniteNumber(value, fallback);
  return number > 0 ? number : 0;
}

/**
 * Normalizes `cursorTrail`. Negative and non-finite values become 0 (disabled);
 * everything else is floored to whole milliseconds.
 */
export function sanitizeCursorTrail(value: unknown): number {
  return Math.floor(clampNonNegative(value, 0));
}

/**
 * Normalizes `cursorTrailDecay` to a `[fast, slow]` pair. Values may be zero (an
 * explicit zero makes the corresponding corners snap instantly); the slow value
 * is clamped to at least the fast value, mirroring kitty.
 */
export function sanitizeCursorTrailDecay(value: unknown): [number, number] {
  const input = Array.isArray(value) ? value : [];
  const fast = clampNonNegative(input[0], DEFAULT_CURSOR_TRAIL_DECAY[0]);
  let slow = clampNonNegative(input[1], DEFAULT_CURSOR_TRAIL_DECAY[1]);
  if (slow < fast) {
    slow = fast;
  }
  return [fast, slow];
}

/**
 * Normalizes `cursorTrailStartThreshold` to a `[x, y]` pair. A single number
 * applies to both axes, mirroring kitty.
 */
export function sanitizeCursorTrailStartThreshold(value: unknown): [number, number] {
  if (Array.isArray(value)) {
    return [
      Math.floor(clampNonNegative(value[0], DEFAULT_CURSOR_TRAIL_START_THRESHOLD[0])),
      Math.floor(clampNonNegative(value[1], DEFAULT_CURSOR_TRAIL_START_THRESHOLD[1]))
    ];
  }
  const both = Math.floor(clampNonNegative(value, DEFAULT_CURSOR_TRAIL_START_THRESHOLD[0]));
  return [both, both];
}

/**
 * Validates `cursorTrailColor`. `none` (the default) means "use the theme's
 * cursor color"; any other value must be parseable by the terminal color
 * parser. Throws for invalid colors so the option setter surfaces the error.
 */
export function sanitizeCursorTrailColor(value: unknown): string {
  if (value === undefined || value === null || value === CURSOR_TRAIL_COLOR_NONE) {
    return CURSOR_TRAIL_COLOR_NONE;
  }
  if (typeof value !== 'string') {
    throw new Error(`"${String(value)}" is not a valid value for cursorTrailColor`);
  }
  try {
    css.toColor(value);
  } catch {
    throw new Error(`"${value}" is not a valid value for cursorTrailColor`);
  }
  return value;
}

/**
 * Resolves raw options into the hot-path shape. Always returns a fresh object so
 * no caller can share or mutate resolved state.
 */
export function resolveCursorTrailOptions(options: ICursorTrailRawOptions): IResolvedCursorTrailOptions {
  const [decayFast, decaySlow] = sanitizeCursorTrailDecay(options.cursorTrailDecay);
  const [thresholdX, thresholdY] = sanitizeCursorTrailStartThreshold(options.cursorTrailStartThreshold);
  const color = sanitizeCursorTrailColor(options.cursorTrailColor);
  return {
    stationaryMs: sanitizeCursorTrail(options.cursorTrail),
    decayFast,
    decaySlow,
    thresholdX,
    thresholdY,
    colorRgba: color === CURSOR_TRAIL_COLOR_NONE ? undefined : css.toColor(color).rgba
  };
}
