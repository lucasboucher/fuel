import type { UsageErrorCode, UsageSnapshot } from './usage.js';

export type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: UsageSnapshot }
  | { kind: 'error'; code: UsageErrorCode; message: string; snapshot?: UsageSnapshot };

export function badgePercentFor(state: ViewState): number | undefined {
  if (state.kind !== 'ready') {
    return undefined;
  }
  return state.snapshot.totalPercentUsed;
}
