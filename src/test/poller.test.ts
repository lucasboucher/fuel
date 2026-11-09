import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideNextPoll,
  POLL_INTERVAL_MS,
  STALE_AFTER_MS,
  shouldRefreshOnFocus,
} from '../poller.js';

test('refreshes immediately on the first pass', () => {
  const decision = decideNextPoll({
    now: 1_000,
    windowFocused: true,
    consecutiveFailures: 0,
  });
  assert.deepEqual(decision, { action: 'refresh' });
});

test('waits while the snapshot is fresh', () => {
  const decision = decideNextPoll({
    now: 10_000,
    windowFocused: true,
    lastSuccessAt: 10_000 - 60_000,
    consecutiveFailures: 0,
  });
  assert.deepEqual(decision, { action: 'wait', delayMs: POLL_INTERVAL_MS - 60_000 });
});

test('refreshes when the snapshot is stale', () => {
  const decision = decideNextPoll({
    now: STALE_AFTER_MS + 5,
    windowFocused: true,
    lastSuccessAt: 0,
    consecutiveFailures: 0,
  });
  assert.deepEqual(decision, { action: 'refresh' });
});

test('stays idle when the window is unfocused', () => {
  const decision = decideNextPoll({
    now: 1_000,
    windowFocused: false,
    consecutiveFailures: 0,
  });
  assert.deepEqual(decision, { action: 'idle' });
});

test('honors a manual refresh', () => {
  const decision = decideNextPoll({
    now: 1_000,
    windowFocused: false,
    consecutiveFailures: 3,
    manual: true,
  });
  assert.deepEqual(decision, { action: 'refresh' });
});

test('backs off after an error', () => {
  const decision = decideNextPoll({
    now: 30_000,
    windowFocused: true,
    lastAttemptAt: 0,
    consecutiveFailures: 2,
  });
  assert.deepEqual(decision, { action: 'wait', delayMs: 90_000 });
});

test('retries when the backoff has elapsed', () => {
  const decision = decideNextPoll({
    now: 120_000,
    windowFocused: true,
    lastAttemptAt: 0,
    consecutiveFailures: 2,
  });
  assert.deepEqual(decision, { action: 'refresh' });
});

test('retries a blocked state on focus, except a missing session', () => {
  const focused = { now: 1_000, lastSuccessAt: 1_000, windowFocused: true };
  assert.equal(shouldRefreshOnFocus({ ...focused, blockedCode: 'missing_account' }), true);
  assert.equal(shouldRefreshOnFocus({ ...focused, blockedCode: 'expired_session' }), true);
  assert.equal(shouldRefreshOnFocus({ ...focused, blockedCode: 'unauthorized' }), true);
  assert.equal(shouldRefreshOnFocus({ ...focused, blockedCode: 'missing_session' }), false);
  assert.equal(
    shouldRefreshOnFocus({ ...focused, windowFocused: false, blockedCode: 'unauthorized' }),
    false,
  );
});

test('refreshes on focus return when the snapshot is stale', () => {
  assert.equal(
    shouldRefreshOnFocus({
      now: STALE_AFTER_MS + 1,
      lastSuccessAt: 0,
      windowFocused: true,
    }),
    true,
  );
  assert.equal(
    shouldRefreshOnFocus({
      now: 1_000,
      lastSuccessAt: 0,
      windowFocused: true,
    }),
    false,
  );
});
