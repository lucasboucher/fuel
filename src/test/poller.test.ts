import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextPoll, STALE_AFTER_MS, shouldRefreshOnFocus, VISIBLE_INTERVAL_MS } from '../poller.js';

test('fetches immediately on the first pass', () => {
  const decision = nextPoll({
    now: 1_000,
    viewVisible: true,
    windowFocused: true,
    consecutiveFailures: 0,
  });
  assert.deepEqual(decision, { action: 'fetch' });
});

test('waits while the snapshot is fresh', () => {
  const decision = nextPoll({
    now: 10_000,
    viewVisible: true,
    windowFocused: true,
    lastSuccessAt: 10_000 - 60_000,
    consecutiveFailures: 0,
  });
  assert.deepEqual(decision, { action: 'wait', delayMs: VISIBLE_INTERVAL_MS - 60_000 });
});

test('fetches when the snapshot is stale', () => {
  const decision = nextPoll({
    now: STALE_AFTER_MS + 5,
    viewVisible: true,
    windowFocused: true,
    lastSuccessAt: 0,
    consecutiveFailures: 0,
  });
  assert.deepEqual(decision, { action: 'fetch' });
});

test('stays idle when the window is unfocused', () => {
  const decision = nextPoll({
    now: 1_000,
    viewVisible: true,
    windowFocused: false,
    consecutiveFailures: 0,
  });
  assert.deepEqual(decision, { action: 'idle' });
});

test('stays idle when the view is hidden', () => {
  const decision = nextPoll({
    now: 1_000,
    viewVisible: false,
    windowFocused: true,
    consecutiveFailures: 0,
  });
  assert.deepEqual(decision, { action: 'idle' });
});

test('honors a manual refresh', () => {
  const decision = nextPoll({
    now: 1_000,
    viewVisible: false,
    windowFocused: false,
    consecutiveFailures: 3,
    manual: true,
  });
  assert.deepEqual(decision, { action: 'fetch' });
});

test('backs off after an error', () => {
  const decision = nextPoll({
    now: 30_000,
    viewVisible: true,
    windowFocused: true,
    lastAttemptAt: 0,
    consecutiveFailures: 2,
  });
  assert.deepEqual(decision, { action: 'wait', delayMs: 90_000 });
});

test('retries when the backoff has elapsed', () => {
  const decision = nextPoll({
    now: 120_000,
    viewVisible: true,
    windowFocused: true,
    lastAttemptAt: 0,
    consecutiveFailures: 2,
  });
  assert.deepEqual(decision, { action: 'fetch' });
});

test('refreshes on focus return when the snapshot is stale', () => {
  assert.equal(
    shouldRefreshOnFocus({
      now: STALE_AFTER_MS + 1,
      lastSuccessAt: 0,
      viewVisible: true,
      windowFocused: true,
    }),
    true,
  );
  assert.equal(
    shouldRefreshOnFocus({
      now: 1_000,
      lastSuccessAt: 0,
      viewVisible: true,
      windowFocused: true,
    }),
    false,
  );
});
