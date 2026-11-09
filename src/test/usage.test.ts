import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSpend, UsageError } from '../usage.js';

test('normalizes spend and computes percent used', () => {
  const snapshot = normalizeSpend(
    {
      subscriptionCycleStart: Date.UTC(2026, 10, 1),
      teamMemberSpend: [
        {
          email: 'ada@example.com',
          name: 'Ada',
          overallSpendCents: 12345,
          spendCents: 2000,
          effectivePerUserLimitDollars: 200,
        },
      ],
    },
    'ada@example.com',
    '2026-11-09T12:00:00.000Z',
  );

  assert.equal(snapshot.overallSpendEuros, 123.45);
  assert.equal(snapshot.includedSpendEuros, 0);
  assert.equal(snapshot.onDemandSpendEuros, 20);
  assert.equal(snapshot.limitEuros, 200);
  assert.equal(snapshot.percentUsed, 61.7);
  assert.equal(snapshot.cycleStart, '2026-11-01T00:00:00.000Z');
  assert.equal(snapshot.name, 'Ada');
});

test('normalizes included pools and percent fields', () => {
  const snapshot = normalizeSpend(
    {
      teamMemberSpend: [
        {
          email: 'ada@example.com',
          includedSpendCents: 8429,
          spendCents: 0,
          autoPercentUsed: 46.2,
          apiPercentUsed: 12.4,
          totalPercentUsed: 31.1,
        },
      ],
    },
    'ada@example.com',
    '2026-11-09T12:00:00.000Z',
  );

  assert.equal(snapshot.includedSpendEuros, 84.29);
  assert.equal(snapshot.onDemandSpendEuros, 0);
  assert.equal(snapshot.overallSpendEuros, 84.29);
  assert.equal(snapshot.cursorModelsPercent, 46.2);
  assert.equal(snapshot.otherModelsPercent, 12.4);
  assert.equal(snapshot.totalPercentUsed, 31.1);
});

test('matches the member row case-insensitively by email', () => {
  const snapshot = normalizeSpend(
    {
      teamMemberSpend: [
        { email: 'other@example.com', overallSpendCents: 1 },
        { email: 'Ada@Example.com', overallSpendCents: 500 },
      ],
    },
    'ada@example.com',
    '2026-11-09T12:00:00.000Z',
  );

  assert.equal(snapshot.overallSpendEuros, 5);
});

test('accepts a single returned member', () => {
  const snapshot = normalizeSpend(
    {
      teamMemberSpend: [{ overallSpendCents: 250, spendCents: 50 }],
    },
    'ada@example.com',
    '2026-11-09T12:00:00.000Z',
  );

  assert.equal(snapshot.overallSpendEuros, 2.5);
  assert.equal(snapshot.limitEuros, undefined);
  assert.equal(snapshot.percentUsed, undefined);
});

test('throws when no matching member is found', () => {
  assert.throws(
    () =>
      normalizeSpend(
        {
          teamMemberSpend: [
            { email: 'a@example.com', overallSpendCents: 1 },
            { email: 'b@example.com', overallSpendCents: 2 },
          ],
        },
        'ada@example.com',
        '2026-11-09T12:00:00.000Z',
      ),
    (error: unknown) => error instanceof UsageError && error.code === 'not_found',
  );
});
