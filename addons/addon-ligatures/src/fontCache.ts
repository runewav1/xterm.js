/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

/**
 * Memoizes an async loader by a caller-provided key. Concurrent requests for the
 * same key share one in-flight load, so a multi-pane workspace parses each font
 * family once instead of once per terminal. A rejected load is not retained, so
 * a later request can retry (for example after a transient permission prompt).
 */
export function memoize<Args extends unknown[], Result>(
  keyOf: (...args: Args) => string,
  load: (...args: Args) => Promise<Result | undefined>
): (...args: Args) => Promise<Result | undefined> {
  const cache = new Map<string, Promise<Result | undefined>>();
  return (...args: Args): Promise<Result | undefined> => {
    const key = keyOf(...args);
    let entry = cache.get(key);
    if (!entry) {
      entry = load(...args).catch(error => {
        cache.delete(key);
        throw error;
      });
      cache.set(key, entry);
    }
    return entry;
  };
}
