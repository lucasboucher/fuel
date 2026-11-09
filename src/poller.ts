export const VISIBLE_INTERVAL_MS = 15 * 60_000;
export const STALE_AFTER_MS = 15 * 60_000;
export const MAX_BACKOFF_MS = 15 * 60_000;

export type PollDecision =
  | { action: 'fetch' }
  | { action: 'wait'; delayMs: number }
  | { action: 'idle' };

export type PollInput = {
  now: number;
  viewVisible: boolean;
  windowFocused: boolean;
  lastSuccessAt?: number;
  lastAttemptAt?: number;
  consecutiveFailures: number;
  manual?: boolean;
};

export function backoffMs(consecutiveFailures: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (consecutiveFailures - 1));
}

export function nextPoll(input: PollInput): PollDecision {
  if (input.manual) {
    return { action: 'fetch' };
  }

  if (!input.windowFocused || !input.viewVisible) {
    return { action: 'idle' };
  }

  if (input.consecutiveFailures > 0) {
    const delayMs = backoffMs(input.consecutiveFailures);
    if (input.lastAttemptAt === undefined) {
      return { action: 'fetch' };
    }
    const elapsed = input.now - input.lastAttemptAt;
    if (elapsed < delayMs) {
      return { action: 'wait', delayMs: delayMs - elapsed };
    }
    return { action: 'fetch' };
  }

  if (input.lastSuccessAt === undefined) {
    return { action: 'fetch' };
  }

  const age = input.now - input.lastSuccessAt;
  if (age >= STALE_AFTER_MS) {
    return { action: 'fetch' };
  }

  return { action: 'wait', delayMs: VISIBLE_INTERVAL_MS - age };
}

export function shouldRefreshOnFocus(input: {
  now: number;
  lastSuccessAt?: number;
  viewVisible: boolean;
  windowFocused: boolean;
}): boolean {
  if (!input.viewVisible || !input.windowFocused) {
    return false;
  }
  if (input.lastSuccessAt === undefined) {
    return true;
  }
  return input.now - input.lastSuccessAt >= STALE_AFTER_MS;
}
