/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { css } from './Color';
import { CursorSmearEasing, CursorSmearStyle, ICursorSmearOptions } from './Types';

const enum Constants {
  DEFAULT_DURATION = 120,
  MAX_DURATION = 5000,
  DEFAULT_SAMPLES = 4,
  MAX_SAMPLES = 16,
  DEFAULT_OPACITY = 0.5,
  DEFAULT_MIN_DISTANCE = 1,
  MAX_DISTANCE = 1000
}

/**
 * Fully resolved smear options. Unlike {@link ICursorSmearOptions} every field
 * is present, numerics are finite and bounded and `color` has been parsed to a
 * 32-bit RGBA word so the animation hot path performs no parsing.
 */
export interface IResolvedCursorSmearOptions {
  enabled: boolean;
  duration: number;
  style: CursorSmearStyle;
  samples: number;
  opacity: number;
  /** Parsed override color, or undefined to use the theme cursor color. */
  colorRgba: number | undefined;
  easing: CursorSmearEasing;
  minDistance: number;
  /** Maximum travel in cells, 0 means unlimited. */
  maxDistance: number;
  endScale: number;
  respectReducedMotion: boolean;
}

export function isCursorSmearStyle(value: unknown): value is CursorSmearStyle {
  return value === 'fade' || value === 'trail';
}

export function isCursorSmearEasing(value: unknown): value is CursorSmearEasing {
  return value === 'linear' || value === 'easeOut' || value === 'easeInOut';
}

function toFinite(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Validates and normalizes user supplied smear options, returning a fresh
 * object so no caller can share or mutate resolved state. Invalid enum values
 * and colors throw, matching the `cursorStyle` option convention.
 */
export function sanitizeCursorSmearOptions(value: ICursorSmearOptions | undefined): ICursorSmearOptions {
  const input = value ?? {};

  let style: CursorSmearStyle = 'trail';
  if (input.style !== undefined) {
    if (!isCursorSmearStyle(input.style)) {
      throw new Error(`"${input.style}" is not a valid value for cursorSmear.style`);
    }
    style = input.style;
  }

  let easing: CursorSmearEasing = 'easeOut';
  if (input.easing !== undefined) {
    if (!isCursorSmearEasing(input.easing)) {
      throw new Error(`"${input.easing}" is not a valid value for cursorSmear.easing`);
    }
    easing = input.easing;
  }

  let color: string | undefined;
  if (input.color !== undefined && input.color !== null) {
    if (typeof input.color !== 'string') {
      throw new Error(`"${String(input.color)}" is not a valid value for cursorSmear.color`);
    }
    try {
      css.toColor(input.color);
    } catch {
      throw new Error(`"${input.color}" is not a valid value for cursorSmear.color`);
    }
    color = input.color;
  }

  const minDistance = clamp(Math.floor(toFinite(input.minDistance, Constants.DEFAULT_MIN_DISTANCE)), 0, Constants.MAX_DISTANCE);
  let maxDistance = clamp(Math.floor(toFinite(input.maxDistance, 0)), 0, Constants.MAX_DISTANCE);
  if (maxDistance > 0 && maxDistance < minDistance) {
    maxDistance = minDistance;
  }

  return {
    enabled: input.enabled === true,
    duration: clamp(Math.floor(toFinite(input.duration, Constants.DEFAULT_DURATION)), 0, Constants.MAX_DURATION),
    style,
    samples: clamp(Math.floor(toFinite(input.samples, Constants.DEFAULT_SAMPLES)), 1, Constants.MAX_SAMPLES),
    opacity: clamp(toFinite(input.opacity, Constants.DEFAULT_OPACITY), 0, 1),
    color,
    easing,
    minDistance,
    maxDistance,
    endScale: clamp(toFinite(input.endScale, 1), 0, 1),
    respectReducedMotion: input.respectReducedMotion !== false
  };
}

/**
 * Resolves options for the animation hot path. Always returns a fresh object.
 */
export function resolveCursorSmearOptions(value: ICursorSmearOptions | undefined): IResolvedCursorSmearOptions {
  const sanitized = sanitizeCursorSmearOptions(value);
  return {
    enabled: sanitized.enabled!,
    duration: sanitized.duration!,
    style: sanitized.style!,
    samples: sanitized.samples!,
    opacity: sanitized.opacity!,
    colorRgba: sanitized.color !== undefined ? css.toColor(sanitized.color).rgba : undefined,
    easing: sanitized.easing!,
    minDistance: sanitized.minDistance!,
    maxDistance: sanitized.maxDistance!,
    endScale: sanitized.endScale!,
    respectReducedMotion: sanitized.respectReducedMotion!
  };
}
