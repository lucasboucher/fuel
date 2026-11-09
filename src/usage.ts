import type { CursorAccount } from './session.js';

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
    isDateString(snapshot.fetchedAt)
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
const REQUEST_TIMEOUT_MS = 10_000;

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
  };
}

export async function fetchUsageSnapshot(input: {
  cookie: string;
  account: CursorAccount;
}): Promise<UsageSnapshot> {
  let response: Response;
  try {
    response = await fetch(USAGE_SUMMARY_URL, {
      headers: { Cookie: input.cookie },
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

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw unreadableSummaryError();
  }
  return snapshotFromSummary(payload, input.account, new Date().toISOString());
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
