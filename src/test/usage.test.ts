import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchSpend,
  isSpendSnapshot,
  mustForgetSnapshot,
  normalizeSpend,
  snapshotForAccount,
  UsageError,
} from '../usage.js';

test('isSpendSnapshot accepts current snapshots and rejects legacy euro fields', () => {
  assert.equal(
    isSpendSnapshot({
      email: 'ada@example.com',
      overallSpendDollars: 1,
      includedSpendDollars: 1,
      onDemandSpendDollars: 0,
      fetchedAt: '2026-11-09T12:00:00.000Z',
    }),
    true,
  );
  assert.equal(
    isSpendSnapshot({
      email: 'ada@example.com',
      overallSpendEuros: 1,
      includedSpendEuros: 1,
      onDemandSpendEuros: 0,
      fetchedAt: '2026-11-09T12:00:00.000Z',
    }),
    false,
  );
});

test('keeps the signed-in snapshot and marks the others for deletion', () => {
  const ada = {
    email: 'Ada@Example.com',
    overallSpendDollars: 1,
    includedSpendDollars: 1,
    onDemandSpendDollars: 0,
    fetchedAt: '2026-11-09T12:00:00.000Z',
  };
  assert.equal(snapshotForAccount(ada, 'ada@example.com'), ada);
  assert.equal(snapshotForAccount(ada, 'other@example.com'), undefined);
  assert.equal(snapshotForAccount(ada, undefined), undefined);
  assert.equal(mustForgetSnapshot(undefined, 'ada@example.com'), false);
  assert.equal(mustForgetSnapshot(ada, undefined), false);
  assert.equal(mustForgetSnapshot(ada, 'ada@example.com'), false);
  assert.equal(mustForgetSnapshot(ada, 'other@example.com'), true);
  assert.equal(mustForgetSnapshot({ email: 'ada@example.com' }, 'ada@example.com'), true);
});

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

  assert.equal(snapshot.overallSpendDollars, 123.45);
  assert.equal(snapshot.includedSpendDollars, 103.45);
  assert.equal(snapshot.onDemandSpendDollars, 20);
  assert.equal(snapshot.limitDollars, 200);
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

  assert.equal(snapshot.includedSpendDollars, 84.29);
  assert.equal(snapshot.onDemandSpendDollars, 0);
  assert.equal(snapshot.overallSpendDollars, 84.29);
  assert.equal(snapshot.cursorModelsPercent, 46.2);
  assert.equal(snapshot.otherModelsPercent, 12.4);
  assert.equal(snapshot.totalPercentUsed, 31.1);
});

test('keeps fractional cent precision when converting to dollars', () => {
  const snapshot = normalizeSpend(
    {
      teamMemberSpend: [
        {
          email: 'ada@example.com',
          spendCents: 2450.125487,
          includedSpendCents: 100.004,
        },
      ],
    },
    'ada@example.com',
    '2026-11-09T12:00:00.000Z',
  );

  assert.equal(snapshot.onDemandSpendDollars, 24.5);
  assert.equal(snapshot.includedSpendDollars, 1);
  assert.equal(snapshot.overallSpendDollars, 25.5);
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

  assert.equal(snapshot.overallSpendDollars, 5);
});

test('rejects a lone member row that does not match the signed-in email', () => {
  assert.throws(
    () =>
      normalizeSpend(
        {
          teamMemberSpend: [{ overallSpendCents: 250, spendCents: 50 }],
        },
        'ada@example.com',
        '2026-11-09T12:00:00.000Z',
      ),
    (error: unknown) => error instanceof UsageError && error.code === 'not_found',
  );
});

test('derives included spend by subtracting cents before rounding to dollars', () => {
  const snapshot = normalizeSpend(
    {
      teamMemberSpend: [
        {
          email: 'ada@example.com',
          overallSpendCents: 2.5,
          spendCents: 1.4,
        },
      ],
    },
    'ada@example.com',
    '2026-11-09T12:00:00.000Z',
  );

  // Rounding each side first would yield $0.02 included; subtract-then-round yields $0.01.
  assert.equal(snapshot.overallSpendDollars, 0.03);
  assert.equal(snapshot.onDemandSpendDollars, 0.01);
  assert.equal(snapshot.includedSpendDollars, 0.01);
});

test('ignores non-finite subscriptionCycleStart', () => {
  const snapshot = normalizeSpend(
    {
      subscriptionCycleStart: Number.NaN,
      teamMemberSpend: [{ email: 'ada@example.com', includedSpendCents: 100, spendCents: 0 }],
    },
    'ada@example.com',
    '2026-11-09T12:00:00.000Z',
  );

  assert.equal(snapshot.cycleStart, undefined);
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

test('fetchSpend retries grok_ keys with Bearer after Basic 401', async () => {
  const modes: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const authorization = String(
      init && typeof init === 'object' && 'headers' in init
        ? (init.headers as Record<string, string>).Authorization
        : '',
    );
    if (authorization.startsWith('Basic ')) {
      modes.push('basic');
      return new Response(JSON.stringify({ message: 'unauthorized' }), {
        status: 401,
      });
    }
    modes.push('bearer');
    return new Response(
      JSON.stringify({
        teamMemberSpend: [{ email: 'ada@example.com', includedSpendCents: 100, spendCents: 0 }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const snapshot = await fetchSpend({
    apiKey: 'grok_test',
    email: 'ada@example.com',
    fetchImpl,
  });

  assert.deepEqual(modes, ['basic', 'bearer']);
  assert.equal(snapshot.includedSpendDollars, 1);
});

test('fetchSpend maps 401 to unauthorized without Bearer retry for crsr_ keys', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: 'nope' }), { status: 401 });
  };

  await assert.rejects(
    () => fetchSpend({ apiKey: 'crsr_test', email: 'ada@example.com', fetchImpl }),
    (error: unknown) => error instanceof UsageError && error.code === 'unauthorized',
  );
  assert.equal(calls, 1);
});

test('fetchSpend maps 403 to forbidden', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ error: 'blocked' }), { status: 403 });

  await assert.rejects(
    () => fetchSpend({ apiKey: 'crsr_test', email: 'ada@example.com', fetchImpl }),
    (error: unknown) => error instanceof UsageError && error.code === 'forbidden',
  );
});
