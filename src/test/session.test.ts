import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withTimeout } from '../session.js';

test('withTimeout resolves when the promise wins', async () => {
  const value = await withTimeout(Promise.resolve('ok'), 100);
  assert.equal(value, 'ok');
});

test('withTimeout rejects when the deadline elapses', async () => {
  let resolveLate: ((value: string) => void) | undefined;
  const late = new Promise<string>((resolve) => {
    resolveLate = resolve;
  });

  await assert.rejects(() => withTimeout(late, 10), /Timed out after 10ms/);
  resolveLate?.('late');
});
