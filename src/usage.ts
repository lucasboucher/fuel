import {
  type ConversationSpend,
  conversationIdsForLabels,
  groupConversationSpends,
  isConversationSpend,
  parseUsageEvent,
  type UsageEvent,
} from './conversations.js';
import type { CursorAccount } from './session.js';
import { readConversationLabels } from './transcripts.js';

export type { ConversationSpend };

export type UsageSnapshot = {
  email: string;
  displayName: string;
  teamName: string;
  overallSpendDollars: number;
  includedSpendDollars: number;
  onDemandSpendDollars: number;
  teamOnDemandEnabled: boolean;
  teamSpendLimitDollars: number | null;
  cursorModelsPercentUsed: number;
  otherModelsPercentUsed: number;
  totalPercentUsed: number;
  cycleStart: string;
  cycleEnd: string;
  fetchedAt: string;
  conversations: ConversationSpend[];
};

export function snapshotForAccount(
  cached: unknown,
  email: string | undefined,
): UsageSnapshot | undefined {
  if (!email || !isUsageSnapshot(cached)) {
    return undefined;
  }
  if (cached.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
    return undefined;
  }
  return cached;
}

export function mustForgetSnapshot(cached: unknown, email: string | undefined): boolean {
  if (cached === undefined) {
    return false;
  }
  if (!isUsageSnapshot(cached)) {
    return true;
  }
  if (!email) {
    return false;
  }
  return snapshotForAccount(cached, email) === undefined;
}

export function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.email === 'string' &&
    isNonEmptyString(snapshot.displayName) &&
    isNonEmptyString(snapshot.teamName) &&
    isNonNegativeNumber(snapshot.overallSpendDollars) &&
    isNonNegativeNumber(snapshot.includedSpendDollars) &&
    isNonNegativeNumber(snapshot.onDemandSpendDollars) &&
    typeof snapshot.teamOnDemandEnabled === 'boolean' &&
    (snapshot.teamSpendLimitDollars === null ||
      isNonNegativeNumber(snapshot.teamSpendLimitDollars)) &&
    isNonNegativeNumber(snapshot.cursorModelsPercentUsed) &&
    isNonNegativeNumber(snapshot.otherModelsPercentUsed) &&
    isNonNegativeNumber(snapshot.totalPercentUsed) &&
    isDateString(snapshot.cycleStart) &&
    isDateString(snapshot.cycleEnd) &&
    isDateString(snapshot.fetchedAt) &&
    Array.isArray(snapshot.conversations) &&
    snapshot.conversations.every(isConversationSpend)
  );
}

export type UsageErrorCode =
  | 'missing_account'
  | 'missing_session'
  | 'expired_session'
  | 'unauthorized'
  | 'http_status'
  | 'unreadable'
  | 'network'
  | 'unexpected';

export function blocksPolling(code: UsageErrorCode): boolean {
  return (
    code === 'missing_account' ||
    code === 'missing_session' ||
    code === 'expired_session' ||
    code === 'unauthorized'
  );
}

export class UsageError extends Error {
  constructor(
    readonly code: UsageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';
const FILTERED_USAGE_EVENTS_URL = 'https://cursor.com/api/dashboard/get-filtered-usage-events';
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 200;

type UsageSummary = {
  billingCycleStart: unknown;
  billingCycleEnd: unknown;
  individualUsage?: {
    plan?: {
      autoPercentUsed?: unknown;
      apiPercentUsed?: unknown;
      totalPercentUsed?: unknown;
      breakdown?: { total?: unknown };
    };
    onDemand?: { used?: unknown };
  };
  teamUsage?: { onDemand?: { enabled?: unknown; limit?: unknown } };
};

export function snapshotFromSummary(
  payload: unknown,
  account: CursorAccount,
  fetchedAt: string,
  conversations: ConversationSpend[],
): UsageSnapshot {
  if (!payload || typeof payload !== 'object') {
    throw unreadableSummaryError();
  }
  const summary = payload as UsageSummary;
  const plan = summary.individualUsage?.plan;
  const teamOnDemand = summary.teamUsage?.onDemand;
  const includedCents = requireNonNegativeNumber(plan?.breakdown?.total);
  const onDemandCents = requireNonNegativeNumber(summary.individualUsage?.onDemand?.used);
  const teamLimitCents = teamOnDemand?.limit;
  if (typeof teamOnDemand?.enabled !== 'boolean') {
    throw unreadableSummaryError();
  }

  return {
    email: account.email,
    displayName: account.displayName,
    teamName: account.teamName,
    overallSpendDollars: centsToDollars(includedCents + onDemandCents),
    includedSpendDollars: centsToDollars(includedCents),
    onDemandSpendDollars: centsToDollars(onDemandCents),
    teamOnDemandEnabled: teamOnDemand.enabled,
    teamSpendLimitDollars:
      teamLimitCents === null ? null : centsToDollars(requireNonNegativeNumber(teamLimitCents)),
    cursorModelsPercentUsed: requirePercent(plan?.autoPercentUsed),
    otherModelsPercentUsed: requirePercent(plan?.apiPercentUsed),
    totalPercentUsed: requirePercent(plan?.totalPercentUsed),
    cycleStart: requireIsoDate(summary.billingCycleStart),
    cycleEnd: requireIsoDate(summary.billingCycleEnd),
    fetchedAt,
    conversations,
  };
}

export async function fetchUsageSnapshot(input: {
  cookie: string;
  account: CursorAccount;
}): Promise<UsageSnapshot> {
  const summaryPayload = await fetchJson(USAGE_SUMMARY_URL, {
    headers: { Cookie: input.cookie },
  });
  const fetchedAt = new Date().toISOString();
  const snapshot = snapshotFromSummary(summaryPayload, input.account, fetchedAt, []);
  const startMs = Date.parse(snapshot.cycleStart);
  const endMs = Date.parse(snapshot.cycleEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw unreadableSummaryError();
  }
  const events = await fetchUsageEvents(input.cookie, startMs, endMs);
  const labelsById = readConversationLabels(conversationIdsForLabels(events));
  return {
    ...snapshot,
    conversations: groupConversationSpends(events, labelsById),
  };
}

async function fetchUsageEvents(
  cookie: string,
  startDate: number,
  endDate: number,
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  let page = 1;
  let total = Infinity;

  while ((page - 1) * PAGE_SIZE < total) {
    if (page > MAX_PAGES) {
      throw unreadableSummaryError();
    }

    const payload = await fetchJson(FILTERED_USAGE_EVENTS_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard?tab=usage',
      },
      body: JSON.stringify({
        startDate: String(startDate),
        endDate: String(endDate),
        page,
        pageSize: PAGE_SIZE,
      }),
    });

    if (!payload || typeof payload !== 'object') {
      throw unreadableSummaryError();
    }
    const body = payload as Record<string, unknown>;
    total = requireNonNegativeNumber(body.totalUsageEventsCount);
    if (!Array.isArray(body.usageEventsDisplay)) {
      throw unreadableSummaryError();
    }
    const rows = body.usageEventsDisplay;
    for (const row of rows) {
      const event = parseUsageEvent(row);
      if (!event) {
        throw unreadableSummaryError();
      }
      events.push(event);
    }
    if (rows.length === 0) {
      break;
    }
    page += 1;
  }

  return events;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new UsageError('network', 'Cursor injoignable. Nouvel essai automatique.');
  }

  if (response.status === 401) {
    throw new UsageError('unauthorized', 'Session Cursor expirée. Redémarre Cursor.');
  }
  if (!response.ok) {
    throw new UsageError(
      'http_status',
      `Cursor indisponible (erreur ${response.status}). Nouvel essai automatique.`,
    );
  }

  try {
    return await response.json();
  } catch {
    throw unreadableSummaryError();
  }
}

function unreadableSummaryError(): UsageError {
  return new UsageError('unreadable', 'Réponse de Cursor illisible. Nouvel essai automatique.');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function requireNonNegativeNumber(value: unknown): number {
  if (!isNonNegativeNumber(value)) {
    throw unreadableSummaryError();
  }
  return value;
}

function requirePercent(value: unknown): number {
  return Math.min(100, Math.round(requireNonNegativeNumber(value) * 10) / 10);
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function requireIsoDate(value: unknown): string {
  if (!isDateString(value)) {
    throw unreadableSummaryError();
  }
  return new Date(value).toISOString();
}

function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}
