import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  composerIdFromText,
  conversationIdForExactTitle,
  emptyTokens,
  formatModelLabel,
  groupByProject,
  groupConversationSpends,
  matchConversationId,
  parseUsageEvent,
  UNATTACHED_CONVERSATION_ID,
  type UsageEvent,
} from '../conversations.js';
import { UNASSIGNED_PROJECT_NAME } from '../transcripts.js';

test('formatModelLabel title-cases slug segments', () => {
  assert.equal(formatModelLabel('default'), 'Auto');
  assert.equal(formatModelLabel('composer-2.5-fast'), 'Composer 2.5 Fast');
  assert.equal(formatModelLabel('cursor-grok-4.5-high'), 'Cursor Grok 4.5 High');
  assert.equal(formatModelLabel('grok-bot-default'), 'Grok Bot Default');
});

test('composerIdFromText prefers sand-subagent ids', () => {
  const id = '89b7c234-aef3-4626-8adf-9a32259cb0ec';
  assert.equal(composerIdFromText(`sand-subagent-${id}`), `sand-subagent-${id}`);
  assert.equal(composerIdFromText(`composer://sand-subagent-${id}?x=1`), `sand-subagent-${id}`);
  assert.equal(composerIdFromText(`prefix-${id}-suffix`), id);
  assert.equal(composerIdFromText('no-id-here'), undefined);
});

test('matchConversationId resolves sand-subagent against the snapshot', () => {
  const sandId = 'sand-subagent-89b7c234-aef3-4626-8adf-9a32259cb0ec';
  const plainId = '8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b';
  const conversations = [{ id: sandId }, { id: plainId }];
  assert.equal(matchConversationId(sandId, conversations), sandId);
  assert.equal(matchConversationId('89b7c234-aef3-4626-8adf-9a32259cb0ec', conversations), sandId);
  assert.equal(matchConversationId(plainId, conversations), plainId);
  assert.equal(
    matchConversationId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', conversations),
    undefined,
  );
});

test('conversationIdForExactTitle requires a unique title', () => {
  const conversations = [
    { id: 'one', title: 'Refactor auth' },
    { id: 'two', title: 'Refactor auth' },
    { id: 'three', title: 'Unique title' },
  ];
  assert.equal(conversationIdForExactTitle('Unique title', conversations), 'three');
  assert.equal(conversationIdForExactTitle('Refactor auth', conversations), undefined);
  assert.equal(conversationIdForExactTitle('  Unique title  ', conversations), 'three');
  assert.equal(conversationIdForExactTitle('', conversations), undefined);
});

const composerEvent = {
  conversationId: '8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b',
  timestamp: '1731196800000',
  chargedCents: 12,
  model: 'claude-4.5-sonnet',
  tokenUsage: {
    inputTokens: 100,
    outputTokens: 40,
    cacheWriteTokens: 10,
    cacheReadTokens: 5,
  },
};

function requireEvent(raw: unknown): UsageEvent {
  const event = parseUsageEvent(raw);
  assert.ok(event);
  return event;
}

test('parseUsageEvent requires timestamp, chargedCents, and model', () => {
  assert.deepEqual(parseUsageEvent(composerEvent), {
    conversationId: '8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b',
    timestampMs: 1_731_196_800_000,
    chargedCents: 12,
    model: 'claude-4.5-sonnet',
    tokens: { input: 100, output: 40, cacheWrite: 10, cacheRead: 5 },
  });
  assert.equal(parseUsageEvent({ ...composerEvent, timestamp: undefined }), undefined);
  assert.equal(
    parseUsageEvent({
      chargedCents: 0,
      timestamp: 1_731_196_800_000,
    }),
    undefined,
  );
  assert.deepEqual(
    parseUsageEvent({
      chargedCents: 0,
      timestamp: 1_731_196_800_000,
      model: 'composer-2.5',
    }),
    {
      conversationId: undefined,
      timestampMs: 1_731_196_800_000,
      chargedCents: 0,
      model: 'composer-2.5',
      tokens: emptyTokens(),
    },
  );
  const { chargedCents: _, ...withoutCharged } = composerEvent;
  assert.equal(parseUsageEvent(withoutCharged), undefined);
});

test('groupConversationSpends sums by conversationId and sorts by date', () => {
  const otherId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const spends = groupConversationSpends(
    [
      requireEvent(composerEvent),
      requireEvent({
        ...composerEvent,
        conversationId: otherId,
        timestamp: '1731283200000',
        chargedCents: 25,
      }),
      requireEvent({
        conversationId: undefined,
        timestamp: '1731100400000',
        chargedCents: 10,
        model: 'composer-2.5',
      }),
    ],
    new Map([
      ['8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b', { title: 'Refactor auth', projectName: 'cursor' }],
    ]),
  );

  assert.equal(spends.length, 3);
  assert.deepEqual(spends[0], {
    id: otherId,
    lastEventAt: '2024-11-11T00:00:00.000Z',
    title: 'Inconnu (aaaaaaaa)',
    projectName: UNASSIGNED_PROJECT_NAME,
    chargedDollars: 0.25,
    models: [
      {
        model: 'claude-4.5-sonnet',
        chargedDollars: 0.25,
        tokens: { input: 100, output: 40, cacheWrite: 10, cacheRead: 5 },
      },
    ],
  });
  assert.deepEqual(spends[1], {
    id: '8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b',
    lastEventAt: '2024-11-10T00:00:00.000Z',
    title: 'Refactor auth',
    projectName: 'cursor',
    chargedDollars: 0.12,
    models: [
      {
        model: 'claude-4.5-sonnet',
        chargedDollars: 0.12,
        tokens: { input: 100, output: 40, cacheWrite: 10, cacheRead: 5 },
      },
    ],
  });
  assert.deepEqual(spends[2], {
    id: UNATTACHED_CONVERSATION_ID,
    lastEventAt: '2024-11-08T21:13:20.000Z',
    title: 'Non rattaché',
    projectName: UNASSIGNED_PROJECT_NAME,
    chargedDollars: 0.1,
    models: [{ model: 'composer-2.5', chargedDollars: 0.1, tokens: emptyTokens() }],
  });
});

test('groupConversationSpends sums tokens across events', () => {
  const id = '8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b';
  const spends = groupConversationSpends(
    [
      requireEvent(composerEvent),
      requireEvent({
        ...composerEvent,
        timestamp: '1731283200000',
        chargedCents: 3,
        tokenUsage: {
          inputTokens: 50,
          outputTokens: 10,
          cacheWriteTokens: 0,
          cacheReadTokens: 20,
        },
      }),
    ],
    new Map(),
  );
  assert.equal(spends[0]?.id, id);
  assert.equal(spends[0]?.lastEventAt, '2024-11-11T00:00:00.000Z');
  assert.deepEqual(spends[0]?.models, [
    {
      model: 'claude-4.5-sonnet',
      chargedDollars: 0.15,
      tokens: { input: 150, output: 50, cacheWrite: 10, cacheRead: 25 },
    },
  ]);
});

test('groupConversationSpends splits models and sorts by charged', () => {
  const spends = groupConversationSpends(
    [
      requireEvent(composerEvent),
      requireEvent({
        ...composerEvent,
        chargedCents: 40,
        model: 'gpt-5',
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        },
      }),
      requireEvent({
        ...composerEvent,
        chargedCents: 8,
        model: 'gpt-5',
        tokenUsage: {
          inputTokens: 20,
          outputTokens: 5,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        },
      }),
    ],
    new Map(),
  );

  assert.deepEqual(spends[0]?.models, [
    {
      model: 'gpt-5',
      chargedDollars: 0.48,
      tokens: { input: 30, output: 10, cacheWrite: 0, cacheRead: 0 },
    },
    {
      model: 'claude-4.5-sonnet',
      chargedDollars: 0.12,
      tokens: { input: 100, output: 40, cacheWrite: 10, cacheRead: 5 },
    },
  ]);
  assert.equal(spends[0]?.chargedDollars, 0.6);
});

test('groupConversationSpends keeps zero-token companion models', () => {
  const spends = groupConversationSpends(
    [
      requireEvent(composerEvent),
      requireEvent({
        ...composerEvent,
        model: 'cursor-grok-4.5-high',
        chargedCents: 0,
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        },
      }),
    ],
    new Map(),
  );

  assert.deepEqual(
    spends[0]?.models.map((model) => model.model),
    ['claude-4.5-sonnet', 'cursor-grok-4.5-high'],
  );
  assert.deepEqual(spends[0]?.models[1]?.tokens, emptyTokens());
  assert.equal(spends[0]?.chargedDollars, 0.12);
});

test('groupConversationSpends labels unknown and sand-subagent ids', () => {
  const spends = groupConversationSpends(
    [
      requireEvent({
        conversationId: 'sand-subagent-89b7c234-aef3-4626-8adf-9a32259cb0ec',
        timestamp: '1731196800000',
        chargedCents: 0,
        model: 'composer-2.5',
      }),
      requireEvent({
        conversationId: '4d86d957-3286-46a8-8e19-b1b0bf5a7e83',
        timestamp: '1731100400000',
        chargedCents: 14,
        model: 'composer-2.5',
      }),
    ],
    new Map(),
  );
  assert.equal(spends[0]?.title, 'Sous-agent (89b7c234)');
  assert.equal(spends[1]?.title, 'Inconnu (4d86d957)');
});

test('groupByProject sums conversations under the project name', () => {
  const projects = groupByProject([
    {
      id: 'one',
      lastEventAt: '2024-11-10T00:00:00.000Z',
      title: 'Un',
      projectName: 'cursor',
      chargedDollars: 2,
      models: [],
    },
    {
      id: 'two',
      lastEventAt: '2024-11-11T00:00:00.000Z',
      title: 'Deux',
      projectName: 'fuel',
      chargedDollars: 5,
      models: [],
    },
    {
      id: 'three',
      lastEventAt: '2024-11-09T00:00:00.000Z',
      title: 'Trois',
      projectName: 'cursor',
      chargedDollars: 0.5,
      models: [],
    },
    {
      id: 'orphan',
      lastEventAt: '2024-11-12T00:00:00.000Z',
      title: 'Orphelin',
      projectName: UNASSIGNED_PROJECT_NAME,
      chargedDollars: 99,
      models: [],
    },
  ]);

  assert.deepEqual(
    projects.map((project) => project.name),
    ['fuel', 'cursor', UNASSIGNED_PROJECT_NAME],
  );
  assert.equal(projects[1]?.chargedDollars, 2.5);
  assert.deepEqual(
    projects[1]?.conversations.map((conversation) => conversation.id),
    ['one', 'three'],
  );
});
