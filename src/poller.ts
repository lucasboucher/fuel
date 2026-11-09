import type { UsageErrorCode } from './usage.js';

export const POLL_INTERVAL_MS = 5 * 60_000;
export const STALE_AFTER_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export type PollDecision =
  | { action: 'refresh' }
  | { action: 'wait'; delayMs: number }
  | { action: 'idle' };

export type PollInput = {
  now: number;
  windowFocused: boolean;
  lastSuccessAt?: number;
  lastAttemptAt?: number;
  consecutiveFailures: number;
  manual?: boolean;
};

function backoffDelayMs(consecutiveFailures: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (consecutiveFailures - 1));
}

export function decideNextPoll(input: PollInput): PollDecision {
  if (input.manual) {
    return { action: 'refresh' };
  }

  if (!input.windowFocused) {
    return { action: 'idle' };
  }

  if (input.consecutiveFailures > 0) {
    const delayMs = backoffDelayMs(input.consecutiveFailures);
    if (input.lastAttemptAt === undefined) {
      return { action: 'refresh' };
    }
    const elapsed = input.now - input.lastAttemptAt;
    if (elapsed < delayMs) {
      return { action: 'wait', delayMs: delayMs - elapsed };
    }
    return { action: 'refresh' };
  }

  if (input.lastSuccessAt === undefined) {
    return { action: 'refresh' };
  }

  const age = input.now - input.lastSuccessAt;
  if (age >= STALE_AFTER_MS) {
    return { action: 'refresh' };
  }

  return { action: 'wait', delayMs: POLL_INTERVAL_MS - age };
}

export function shouldRefreshOnFocus(input: {
  now: number;
  lastSuccessAt?: number;
  windowFocused: boolean;
  blockedCode?: UsageErrorCode;
}): boolean {
  if (!input.windowFocused) {
    return false;
  }
  if (input.blockedCode === 'missing_session') {
    return false;
  }
  if (
    input.blockedCode === 'missing_account' ||
    input.blockedCode === 'expired_session' ||
    input.blockedCode === 'unauthorized'
  ) {
    return true;
  }
  if (input.lastSuccessAt === undefined) {
    return true;
  }
  return input.now - input.lastSuccessAt >= STALE_AFTER_MS;
}
