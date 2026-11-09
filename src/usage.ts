export type SpendSnapshot = {
  email: string;
  name?: string;
  overallSpendEuros: number;
  includedSpendEuros: number;
  onDemandSpendEuros: number;
  limitEuros?: number;
  percentUsed?: number;
  cursorModelsPercent?: number;
  otherModelsPercent?: number;
  totalPercentUsed?: number;
  cycleStart?: string;
  fetchedAt: string;
};

export type UsageErrorCode =
  | 'missing_email'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'network'
  | 'vault';

export class UsageError extends Error {
  constructor(
    readonly code: UsageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

type MemberSpend = {
  email?: string;
  name?: string;
  spendCents?: number;
  overallSpendCents?: number;
  includedSpendCents?: number;
  effectivePerUserLimitDollars?: number | null;
  monthlyLimitDollars?: number | null;
  autoPercentUsed?: number;
  apiPercentUsed?: number;
  totalPercentUsed?: number;
};

type SpendResponse = {
  teamMemberSpend?: MemberSpend[];
  subscriptionCycleStart?: number;
};

const API_BASE = 'https://api.cursor.com';
const REQUEST_TIMEOUT_MS = 10_000;

export async function fetchSpend(input: {
  apiKey: string;
  email: string;
  fetchImpl?: typeof fetch;
}): Promise<SpendSnapshot> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiKey = input.apiKey.trim();
  const body = JSON.stringify({
    searchTerm: input.email,
    page: 1,
    pageSize: 25,
  });

  let response: Response;
  try {
    response = await postSpend(fetchImpl, apiKey, body, 'basic');
    // Fine-grained grok_ keys sometimes prefer Bearer over Basic.
    if (response.status === 401 && apiKey.startsWith('grok_')) {
      response = await postSpend(fetchImpl, apiKey, body, 'bearer');
    }
  } catch {
    throw new UsageError('network', 'Impossible de joindre l’API Cursor.');
  }

  if (response.status === 401) {
    throw new UsageError(
      'unauthorized',
      await detailMessage(
        response,
        'Clé d’API refusée. Vérifie une clé Team (pas User) avec « View member usage ».',
      ),
    );
  }
  if (response.status === 403) {
    throw new UsageError(
      'forbidden',
      await detailMessage(response, 'Cette facturation n’ouvre pas l’endpoint de dépense.'),
    );
  }
  if (!response.ok) {
    throw new UsageError(
      'network',
      await detailMessage(response, `L’API a répondu ${response.status}.`),
    );
  }

  const payload = (await response.json()) as SpendResponse;
  return normalizeSpend(payload, input.email, new Date().toISOString());
}

async function postSpend(
  fetchImpl: typeof fetch,
  apiKey: string,
  body: string,
  mode: 'basic' | 'bearer',
): Promise<Response> {
  const authorization =
    mode === 'basic'
      ? `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`
      : `Bearer ${apiKey}`;

  return fetchImpl(`${API_BASE}/teams/spend`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function detailMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: string; error?: string };
    const detail = payload.message?.trim() || payload.error?.trim();
    if (detail) {
      return `${fallback} (${detail})`;
    }
  } catch {
    // ignore non-JSON bodies
  }
  return fallback;
}

export function normalizeSpend(
  payload: SpendResponse,
  email: string,
  fetchedAt: string,
): SpendSnapshot {
  const members = payload.teamMemberSpend ?? [];
  const target = email.trim().toLowerCase();
  const member =
    members.find((item) => item.email?.trim().toLowerCase() === target) ??
    (members.length === 1 ? members[0] : undefined);

  if (!member) {
    throw new UsageError('not_found', 'Aucune dépense trouvée pour cet e-mail.');
  }

  const includedSpendEuros = centsToEuros(member.includedSpendCents);
  const onDemandSpendEuros = centsToEuros(member.spendCents);
  const overallSpendEuros =
    typeof member.overallSpendCents === 'number' && Number.isFinite(member.overallSpendCents)
      ? centsToEuros(member.overallSpendCents)
      : roundMoney(includedSpendEuros + onDemandSpendEuros);

  const limitDollars = firstPositive(
    member.effectivePerUserLimitDollars,
    member.monthlyLimitDollars,
  );
  const limitEuros = limitDollars === undefined ? undefined : limitDollars;
  const percentUsed =
    limitEuros !== undefined && limitEuros > 0
      ? Math.min(100, Math.round((overallSpendEuros / limitEuros) * 1000) / 10)
      : undefined;

  const cursorModelsPercent = normalizePercent(member.autoPercentUsed);
  const otherModelsPercent = normalizePercent(member.apiPercentUsed);
  const totalPercentUsed = normalizePercent(member.totalPercentUsed);

  const snapshot: SpendSnapshot = {
    email: member.email?.trim() || email,
    overallSpendEuros,
    includedSpendEuros,
    onDemandSpendEuros,
    fetchedAt,
  };

  const name = member.name?.trim();
  if (name) {
    snapshot.name = name;
  }
  if (limitEuros !== undefined) {
    snapshot.limitEuros = limitEuros;
  }
  if (percentUsed !== undefined) {
    snapshot.percentUsed = percentUsed;
  }
  if (cursorModelsPercent !== undefined) {
    snapshot.cursorModelsPercent = cursorModelsPercent;
  }
  if (otherModelsPercent !== undefined) {
    snapshot.otherModelsPercent = otherModelsPercent;
  }
  if (totalPercentUsed !== undefined) {
    snapshot.totalPercentUsed = totalPercentUsed;
  }
  if (typeof payload.subscriptionCycleStart === 'number') {
    snapshot.cycleStart = new Date(payload.subscriptionCycleStart).toISOString();
  }

  return snapshot;
}

function centsToEuros(cents: number | undefined): number {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents < 0) {
    return 0;
  }
  return Math.round(cents) / 100;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizePercent(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(100, Math.round(value * 10) / 10);
}

function firstPositive(...values: Array<number | null | undefined>): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}
