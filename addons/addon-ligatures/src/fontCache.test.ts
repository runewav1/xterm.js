/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { memoize } from './fontCache';

describe('addon-ligatures - fontCache', () => {
  it('shares one in-flight load per key and reuses the result', async () => {
    let calls = 0;
    const load = memoize(
      (key: string) => key,
      async (key: string) => {
        calls++;
        return key.toUpperCase();
      }
    );

    const [a, b] = await Promise.all([load('fira'), load('fira')]);
    assert.strictEqual(calls, 1);
    assert.strictEqual(a, 'FIRA');
    assert.strictEqual(a, b);

    // A later request is served from the cache without loading again.
    assert.strictEqual(await load('fira'), 'FIRA');
    assert.strictEqual(calls, 1);

    // Distinct keys load independently.
    assert.strictEqual(await load('cascadia'), 'CASCADIA');
    assert.strictEqual(calls, 2);
  });

  it('does not retain a failed load so a later request can retry', async () => {
    let calls = 0;
    const load = memoize(
      (key: string) => key,
      async (key: string) => {
        calls++;
        if (calls === 1) {
          throw new Error('transient');
        }
        return key;
      }
    );

    let failed = false;
    try {
      await load('x');
    } catch {
      failed = true;
    }
    assert.isTrue(failed);

    assert.strictEqual(await load('x'), 'x');
    assert.strictEqual(calls, 2);
  });

  it('caches an unresolved result (undefined) so it is not retried', async () => {
    let calls = 0;
    const load = memoize(
      (key: string) => key,
      async (): Promise<string | undefined> => {
        calls++;
        return undefined;
      }
    );

    const first = await load('missing');
    const second = await load('missing');
    assert.isUndefined(first);
    assert.isUndefined(second);
    assert.strictEqual(calls, 1);
  });
});
