import type { SpendSnapshot, UsageErrorCode } from './usage.js';

export type ViewState =
  | { kind: 'loading'; email?: string }
  | { kind: 'needs_key' }
  | { kind: 'ready'; snapshot: SpendSnapshot }
  | { kind: 'error'; code: UsageErrorCode; message: string; snapshot?: SpendSnapshot };

export function badgePercentFor(state: ViewState): number | undefined {
  if (state.kind !== 'ready') {
    return undefined;
  }
  return state.snapshot.totalPercentUsed;
}
