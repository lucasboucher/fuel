import assert from 'node:assert/strict';
import { test } from 'node:test';
import { badgePercentFor } from '../state.js';
import type { SpendSnapshot } from '../usage.js';

function snapshot(partial: Partial<SpendSnapshot> = {}): SpendSnapshot {
  return {
    email: 'ada@example.com',
    overallSpendDollars: 0,
    includedSpendDollars: 0,
    onDemandSpendDollars: 0,
    fetchedAt: '2026-11-09T12:00:00.000Z',
    ...partial,
  };
}

test('badge uses totalPercentUsed on a ready state', () => {
  assert.equal(
    badgePercentFor({
      kind: 'ready',
      snapshot: snapshot({
        totalPercentUsed: 40.5,
        cursorModelsPercent: 46.3,
        percentUsed: 61.7,
      }),
    }),
    40.5,
  );
});

test('badge stays empty when totalPercentUsed is absent', () => {
  assert.equal(
    badgePercentFor({
      kind: 'ready',
      snapshot: snapshot({ cursorModelsPercent: 46.3, percentUsed: 61.7 }),
    }),
    undefined,
  );
});

test('badge stays empty outside the ready state', () => {
  const cached = snapshot({ totalPercentUsed: 40.5 });
  assert.equal(badgePercentFor({ kind: 'loading' }), undefined);
  assert.equal(badgePercentFor({ kind: 'needs_key' }), undefined);
  assert.equal(
    badgePercentFor({
      kind: 'error',
      code: 'network',
      message: 'fail',
      snapshot: cached,
    }),
    undefined,
  );
});
