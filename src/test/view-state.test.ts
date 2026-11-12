import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UsageSnapshot } from '../usage.js';
import { badgePercentFor } from '../view-state.js';

const snapshot: UsageSnapshot = {
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  teamName: 'Analytical',
  overallSpendDollars: 0,
  includedSpendDollars: 0,
  onDemandSpendDollars: 0,
  teamOnDemandEnabled: true,
  teamSpendLimitDollars: null,
  cursorModelsPercentUsed: 46.3,
  otherModelsPercentUsed: 12,
  totalPercentUsed: 40.5,
  cycleStart: '2026-10-11T09:38:09.000Z',
  cycleEnd: '2026-11-11T09:38:09.000Z',
  fetchedAt: '2026-11-09T12:00:00.000Z',
  conversations: [],
};

test('badge uses totalPercentUsed on a ready state', () => {
  assert.equal(badgePercentFor({ kind: 'ready', snapshot }), 40.5);
});

test('badge stays empty outside the ready state', () => {
  assert.equal(badgePercentFor({ kind: 'loading' }), undefined);
  assert.equal(
    badgePercentFor({ kind: 'error', code: 'network', message: 'fail', snapshot }),
    undefined,
  );
});
