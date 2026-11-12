import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blocksPolling,
  fetchUsageSnapshot,
  isUsageSnapshot,
  mustForgetSnapshot,
  snapshotForAccount,
  snapshotFromSummary,
  UsageError,
  type UsageSnapshot,
} from '../usage.js';

const measuredSummary = {
  billingCycleStart: '2026-10-11T09:38:09.000Z',
  billingCycleEnd: '2026-11-11T09:38:09.000Z',
  individualUsage: {
    plan: {
      autoPercentUsed: 50.01428571428571,
      apiPercentUsed: 26.43,
      totalPercentUsed: 46.2408,
      breakdown: { included: 2000, bonus: 56177, total: 58177 },
    },
    onDemand: { enabled: true, used: 0, limit: null, remaining: null },
  },
  teamUsage: {
    onDemand: { enabled: true, used: 0, limit: 200, remaining: 200 },
  },
};

const adaAccount = {
  email: 'Ada@Example.com',
  displayName: 'Ada Lovelace',
  teamName: 'Analytical',
};

const adaConversations = [
  {
    id: '8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b',
    lastEventAt: '2026-11-10T00:00:00.000Z',
    title: 'Refactor auth',
    projectName: 'cursor',
    chargedDollars: 0,
    models: [],
  },
];

const adaSnapshot: UsageSnapshot = snapshotFromSummary(
  measuredSummary,
  adaAccount,
  '2026-11-09T12:00:00.000Z',
  adaConversations,
);

test('isUsageSnapshot accepts complete snapshots only', () => {
  assert.equal(isUsageSnapshot(adaSnapshot), true);
  const { cycleStart: _, ...partial } = adaSnapshot;
  const { displayName: __, ...anonymous } = adaSnapshot;
  const { conversations: ___, ...withoutConversations } = adaSnapshot;
  assert.equal(isUsageSnapshot(partial), false);
  assert.equal(isUsageSnapshot(anonymous), false);
  assert.equal(isUsageSnapshot(withoutConversations), false);
});

test('keeps the signed-in snapshot and marks the others for deletion', () => {
  assert.equal(snapshotForAccount(adaSnapshot, 'ada@example.com'), adaSnapshot);
  assert.equal(snapshotForAccount(adaSnapshot, 'other@example.com'), undefined);
  assert.equal(snapshotForAccount(adaSnapshot, undefined), undefined);
  assert.equal(mustForgetSnapshot(undefined, 'ada@example.com'), false);
  assert.equal(mustForgetSnapshot(adaSnapshot, undefined), false);
  assert.equal(mustForgetSnapshot(adaSnapshot, 'ada@example.com'), false);
  assert.equal(mustForgetSnapshot(adaSnapshot, 'other@example.com'), true);
  assert.equal(mustForgetSnapshot({ email: 'ada@example.com' }, 'ada@example.com'), true);
});

test('reads identity, spend, percents, cycle dates, and the team limit', () => {
  assert.equal(adaSnapshot.displayName, 'Ada Lovelace');
  assert.equal(adaSnapshot.teamName, 'Analytical');
  assert.equal(adaSnapshot.overallSpendDollars, 581.77);
  assert.equal(adaSnapshot.includedSpendDollars, 581.77);
  assert.equal(adaSnapshot.onDemandSpendDollars, 0);
  assert.equal(adaSnapshot.teamOnDemandEnabled, true);
  assert.equal(adaSnapshot.teamSpendLimitDollars, 2);
  assert.equal(adaSnapshot.cursorModelsPercentUsed, 50);
  assert.equal(adaSnapshot.otherModelsPercentUsed, 26.4);
  assert.equal(adaSnapshot.totalPercentUsed, 46.2);
  assert.equal(adaSnapshot.cycleStart, '2026-10-11T09:38:09.000Z');
  assert.equal(adaSnapshot.cycleEnd, '2026-11-11T09:38:09.000Z');
  assert.deepEqual(adaSnapshot.conversations, adaConversations);
});

test('adds on-demand to the overall spend and keeps a null team limit', () => {
  const snapshot = snapshotFromSummary(
    {
      ...measuredSummary,
      individualUsage: { ...measuredSummary.individualUsage, onDemand: { used: 50 } },
      teamUsage: { onDemand: { enabled: false, limit: null } },
    },
    adaAccount,
    '2026-11-09T12:00:00.000Z',
    [],
  );

  assert.equal(snapshot.teamOnDemandEnabled, false);
  assert.equal(snapshot.onDemandSpendDollars, 0.5);
  assert.equal(snapshot.overallSpendDollars, 582.27);
  assert.equal(snapshot.teamSpendLimitDollars, null);
});

test('rejects a measuredSummary with a missing field', () => {
  const { billingCycleEnd: _, ...partial } = measuredSummary;
  const { teamUsage: __, ...individualOnly } = measuredSummary;
  assert.throws(
    () => snapshotFromSummary(partial, adaAccount, 'now', []),
    (error: unknown) => error instanceof UsageError && error.code === 'unreadable',
  );
  assert.throws(
    () => snapshotFromSummary(individualOnly, adaAccount, 'now', []),
    (error: unknown) => error instanceof UsageError && error.code === 'unreadable',
  );
  assert.throws(
    () => snapshotFromSummary({ ...measuredSummary, teamUsage: {} }, adaAccount, 'now', []),
    (error: unknown) => error instanceof UsageError && error.code === 'unreadable',
  );
  assert.throws(
    () =>
      snapshotFromSummary(
        { ...measuredSummary, teamUsage: { onDemand: { enabled: true } } },
        adaAccount,
        'now',
        [],
      ),
    (error: unknown) => error instanceof UsageError && error.code === 'unreadable',
  );
});

test('stops polling only when retrying cannot succeed', () => {
  assert.equal(blocksPolling('missing_account'), true);
  assert.equal(blocksPolling('missing_session'), true);
  assert.equal(blocksPolling('expired_session'), true);
  assert.equal(blocksPolling('unauthorized'), true);
  assert.equal(blocksPolling('network'), false);
  assert.equal(blocksPolling('http_status'), false);
  assert.equal(blocksPolling('unreadable'), false);
  assert.equal(blocksPolling('unexpected'), false);
});

test('fetchUsageSnapshot maps 401 to an expired session', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 401 }));
  await assert.rejects(
    () => fetchUsageSnapshot({ cookie: 'WorkosCursorSessionToken=x', account: adaAccount }),
    (error: unknown) => error instanceof UsageError && error.code === 'unauthorized',
  );
});

test('fetchUsageSnapshot maps other HTTP failures to http_status', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('down', { status: 503 }));
  await assert.rejects(
    () => fetchUsageSnapshot({ cookie: 'WorkosCursorSessionToken=x', account: adaAccount }),
    (error: unknown) => error instanceof UsageError && error.code === 'http_status',
  );
});

test('fetchUsageSnapshot loads conversations after the summary', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/usage-summary')) {
      return Response.json(measuredSummary);
    }
    if (url.includes('/api/dashboard/get-filtered-usage-events')) {
      return Response.json({
        totalUsageEventsCount: 1,
        usageEventsDisplay: [
          {
            conversationId: '8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b',
            timestamp: '1731196800000',
            chargedCents: 0,
            model: 'composer-2.5',
            tokenUsage: {
              inputTokens: 120,
              outputTokens: 30,
              cacheWriteTokens: 8,
              cacheReadTokens: 2,
            },
          },
        ],
      });
    }
    return new Response('missing', { status: 404 });
  });

  const snapshot = await fetchUsageSnapshot({
    cookie: 'WorkosCursorSessionToken=x',
    account: adaAccount,
  });
  assert.equal(snapshot.overallSpendDollars, 581.77);
  assert.equal(snapshot.conversations.length, 1);
  assert.deepEqual(snapshot.conversations[0], {
    id: '8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b',
    lastEventAt: '2024-11-10T00:00:00.000Z',
    title: 'Inconnu (8f2e4a1b)',
    projectName: 'Sans projet',
    chargedDollars: 0,
    models: [
      {
        model: 'composer-2.5',
        chargedDollars: 0,
        tokens: { input: 120, output: 30, cacheWrite: 8, cacheRead: 2 },
      },
    ],
  });
});

test('fetchUsageSnapshot rejects an event missing chargedCents', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/usage-summary')) {
      return Response.json(measuredSummary);
    }
    return Response.json({
      totalUsageEventsCount: 1,
      usageEventsDisplay: [
        {
          conversationId: '8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b',
          timestamp: '1731196800000',
          model: 'composer-2.5',
        },
      ],
    });
  });

  await assert.rejects(
    () => fetchUsageSnapshot({ cookie: 'WorkosCursorSessionToken=x', account: adaAccount }),
    (error: unknown) => error instanceof UsageError && error.code === 'unreadable',
  );
});
