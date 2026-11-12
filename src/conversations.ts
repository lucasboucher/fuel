import { type ConversationLabel, UNASSIGNED_PROJECT_NAME } from './transcripts.js';

export const UNATTACHED_CONVERSATION_ID = 'unattached';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SAND_SUBAGENT_RE =
  /sand-subagent-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export type TokenBreakdown = {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
};

export type ModelSpend = {
  model: string;
  chargedDollars: number;
  tokens: TokenBreakdown;
};

export type ConversationSpend = {
  id: string;
  lastEventAt: string;
  title: string;
  projectName: string;
  chargedDollars: number;
  models: ModelSpend[];
};

export type ConversationProject = {
  name: string;
  chargedDollars: number;
  conversations: ConversationSpend[];
};

export type UsageEvent = {
  conversationId: string | undefined;
  timestampMs: number;
  chargedCents: number;
  model: string;
  tokens: TokenBreakdown;
};

/** Cursor bills Auto usage as the slug `default`; show the product name instead. */
export function formatModelLabel(model: string): string {
  if (model === 'default') {
    return 'Auto';
  }
  return model
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function emptyTokens(): TokenBreakdown {
  return { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };
}

export function addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    input: a.input + b.input,
    output: a.output + b.output,
  };
}

export function totalTokens(tokens: TokenBreakdown): number {
  return tokens.cacheRead + tokens.cacheWrite + tokens.input + tokens.output;
}

export function groupConversationSpends(
  events: UsageEvent[],
  labelsById: ReadonlyMap<string, ConversationLabel>,
): ConversationSpend[] {
  const buckets = new Map<
    string,
    {
      chargedCents: number;
      latestTimestampMs: number;
      models: Map<string, { chargedCents: number; tokens: TokenBreakdown }>;
    }
  >();

  for (const event of events) {
    const id = event.conversationId ?? UNATTACHED_CONVERSATION_ID;
    const bucket = buckets.get(id) ?? {
      chargedCents: 0,
      latestTimestampMs: event.timestampMs,
      models: new Map(),
    };
    bucket.chargedCents += event.chargedCents;
    bucket.latestTimestampMs = Math.max(bucket.latestTimestampMs, event.timestampMs);
    const modelBucket = bucket.models.get(event.model) ?? {
      chargedCents: 0,
      tokens: emptyTokens(),
    };
    modelBucket.chargedCents += event.chargedCents;
    modelBucket.tokens = addTokens(modelBucket.tokens, event.tokens);
    bucket.models.set(event.model, modelBucket);
    buckets.set(id, bucket);
  }

  const spends: ConversationSpend[] = [];
  for (const [id, bucket] of buckets) {
    const label = labelsById.get(id);
    spends.push({
      id,
      lastEventAt: new Date(bucket.latestTimestampMs).toISOString(),
      title: conversationTitle(id, label?.title),
      projectName: label?.projectName ?? UNASSIGNED_PROJECT_NAME,
      chargedDollars: Math.round(bucket.chargedCents) / 100,
      models: modelSpendsFromBucket(bucket.models),
    });
  }

  spends.sort((a, b) => {
    const byDate = Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt);
    if (byDate !== 0) {
      return byDate;
    }
    return a.id.localeCompare(b.id);
  });
  return spends;
}

export function groupByProject(conversations: ConversationSpend[]): ConversationProject[] {
  const buckets = new Map<string, ConversationSpend[]>();
  for (const conversation of conversations) {
    const list = buckets.get(conversation.projectName);
    if (list) {
      list.push(conversation);
    } else {
      buckets.set(conversation.projectName, [conversation]);
    }
  }

  const projects: ConversationProject[] = [];
  for (const [name, items] of buckets) {
    const chargedCents = items.reduce(
      (sum, item) => sum + Math.round(item.chargedDollars * 100),
      0,
    );
    projects.push({
      name,
      conversations: items,
      chargedDollars: chargedCents / 100,
    });
  }

  projects.sort((a, b) => {
    const aUnassigned = a.name === UNASSIGNED_PROJECT_NAME;
    const bUnassigned = b.name === UNASSIGNED_PROJECT_NAME;
    if (aUnassigned !== bUnassigned) {
      return aUnassigned ? 1 : -1;
    }
    if (b.chargedDollars !== a.chargedDollars) {
      return b.chargedDollars - a.chargedDollars;
    }
    return a.name.localeCompare(b.name, 'fr');
  });
  return projects;
}

export function parseUsageEvent(raw: unknown): UsageEvent | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  if (row.chargedCents === undefined || row.chargedCents === null) {
    return undefined;
  }
  const chargedCents = coerceNonNegativeNumber(row.chargedCents);
  const timestampMs = parseTimestampMs(row.timestamp);
  const model = optionalNonEmptyString(row.model);
  if (chargedCents === undefined || timestampMs === undefined || model === undefined) {
    return undefined;
  }

  return {
    conversationId: optionalNonEmptyString(row.conversationId),
    timestampMs,
    chargedCents,
    model,
    tokens: tokensFromUnknown(row.tokenUsage),
  };
}

export function tokensFromUnknown(raw: unknown): TokenBreakdown {
  if (!raw || typeof raw !== 'object') {
    return emptyTokens();
  }
  const row = raw as Record<string, unknown>;
  return {
    input: coerceNonNegativeNumber(row.inputTokens) ?? 0,
    output: coerceNonNegativeNumber(row.outputTokens) ?? 0,
    cacheWrite: coerceNonNegativeNumber(row.cacheWriteTokens) ?? 0,
    cacheRead: coerceNonNegativeNumber(row.cacheReadTokens) ?? 0,
  };
}

export function conversationIdsForLabels(events: UsageEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.conversationId) {
      ids.add(event.conversationId);
    }
  }
  return ids;
}

/** Prefer `sand-subagent-<uuid>` when present in the text, else the first UUID. */
export function composerIdFromText(text: string): string | undefined {
  const sand = text.match(SAND_SUBAGENT_RE);
  if (sand?.[1]) {
    return `sand-subagent-${sand[1]}`;
  }
  return text.match(UUID_RE)?.[0];
}

/** Resolve a candidate id against billed conversation ids (including sand-subagent-). */
export function matchConversationId(
  candidate: string | undefined,
  conversations: readonly Pick<ConversationSpend, 'id'>[],
): string | undefined {
  if (!candidate) {
    return undefined;
  }
  if (conversations.some((conversation) => conversation.id === candidate)) {
    return candidate;
  }
  if (!candidate.startsWith('sand-subagent-')) {
    const sandId = `sand-subagent-${candidate}`;
    if (conversations.some((conversation) => conversation.id === sandId)) {
      return sandId;
    }
  }
  return undefined;
}

/** Exact title match only when that title is unique in the snapshot. */
export function conversationIdForExactTitle(
  title: string,
  conversations: readonly Pick<ConversationSpend, 'id' | 'title'>[],
): string | undefined {
  const normalized = title.trim();
  if (!normalized) {
    return undefined;
  }
  const matches = conversations.filter((conversation) => conversation.title === normalized);
  return matches.length === 1 ? matches[0]?.id : undefined;
}

export function isConversationSpend(value: unknown): value is ConversationSpend {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const spend = value as Record<string, unknown>;
  return (
    isNonEmptyString(spend.id) &&
    isDateString(spend.lastEventAt) &&
    isNonEmptyString(spend.title) &&
    isNonEmptyString(spend.projectName) &&
    isNonNegativeNumber(spend.chargedDollars) &&
    Array.isArray(spend.models) &&
    spend.models.every(isModelSpend)
  );
}

function modelSpendsFromBucket(
  models: Map<string, { chargedCents: number; tokens: TokenBreakdown }>,
): ModelSpend[] {
  const spends: ModelSpend[] = [];
  for (const [model, bucket] of models) {
    spends.push({
      model,
      chargedDollars: Math.round(bucket.chargedCents) / 100,
      tokens: bucket.tokens,
    });
  }
  spends.sort((a, b) => {
    if (b.chargedDollars !== a.chargedDollars) {
      return b.chargedDollars - a.chargedDollars;
    }
    if (totalTokens(b.tokens) !== totalTokens(a.tokens)) {
      return totalTokens(b.tokens) - totalTokens(a.tokens);
    }
    return a.model.localeCompare(b.model);
  });
  return spends;
}

function isModelSpend(value: unknown): value is ModelSpend {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const spend = value as Record<string, unknown>;
  return (
    isNonEmptyString(spend.model) &&
    isNonNegativeNumber(spend.chargedDollars) &&
    isTokenBreakdown(spend.tokens)
  );
}

function isTokenBreakdown(value: unknown): value is TokenBreakdown {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const tokens = value as Record<string, unknown>;
  return (
    isNonNegativeNumber(tokens.cacheRead) &&
    isNonNegativeNumber(tokens.cacheWrite) &&
    isNonNegativeNumber(tokens.input) &&
    isNonNegativeNumber(tokens.output)
  );
}

function conversationTitle(id: string, title: string | undefined): string {
  if (id === UNATTACHED_CONVERSATION_ID) {
    return 'Non rattaché';
  }
  if (title) {
    return title;
  }
  if (id.startsWith('sand-subagent-')) {
    return `Sous-agent (${shortConversationId(id.slice('sand-subagent-'.length))})`;
  }
  return `Inconnu (${shortConversationId(id)})`;
}

function shortConversationId(id: string): string {
  return id.slice(0, 8);
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    if (/^\d+$/.test(value.trim())) {
      return parseTimestampMs(Number(value));
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
