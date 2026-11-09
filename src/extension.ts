import * as vscode from 'vscode';
import { decideNextPoll, shouldRefreshOnFocus } from './poller.js';
import { readCachedAccount, readSessionCookie } from './session.js';
import {
  blocksPolling,
  fetchUsageSnapshot,
  mustForgetSnapshot,
  snapshotForAccount,
  UsageError,
  type UsageSnapshot,
} from './usage.js';
import { FuelTreeDataProvider } from './view.js';
import type { ViewState } from './view-state.js';

const SNAPSHOT_KEY = 'fuel.snapshot';
const REFRESHING_CONTEXT_KEY = 'fuel.refreshing';
const DASHBOARD_URL = 'https://cursor.com/dashboard/spending';

export function activate(context: vscode.ExtensionContext): void {
  const treeDataProvider = new FuelTreeDataProvider();
  let lastSuccessAt: number | undefined;
  let lastAttemptAt: number | undefined;
  let consecutiveFailures = 0;
  let inflightRefresh: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshGeneration = 0;
  let disposed = false;

  const setRefreshingContext = (refreshing: boolean): void => {
    void vscode.commands.executeCommand('setContext', REFRESHING_CONTEXT_KEY, refreshing);
  };

  const isBlocked = (): boolean => {
    const state = treeDataProvider.getState();
    return state.kind === 'error' && blocksPolling(state.code);
  };

  // Each globalState write is echoed back and replaces the whole map.
  // Chain them so an older echo cannot drop a newer value. A rejected write
  // still resolves, so the view can show the snapshot and the next write runs.
  let snapshotWriteChain: Promise<void> = Promise.resolve();
  const writeSnapshot = (snapshot: UsageSnapshot | undefined): Promise<void> => {
    const write = (): Thenable<void> => context.globalState.update(SNAPSHOT_KEY, snapshot);
    snapshotWriteChain = snapshotWriteChain.then(write, write).then(
      () => undefined,
      () => undefined,
    );
    return snapshotWriteChain;
  };
  const forgetSnapshot = (): Promise<void> => writeSnapshot(undefined);

  const clearPollTimer = (): void => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };

  const schedulePoll = (manual = false): void => {
    if (disposed) {
      return;
    }
    clearPollTimer();
    if (!manual && isBlocked()) {
      return;
    }

    const decision = decideNextPoll({
      now: Date.now(),
      windowFocused: vscode.window.state.focused,
      consecutiveFailures,
      manual,
      ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
      ...(lastAttemptAt !== undefined ? { lastAttemptAt } : {}),
    });

    if (decision.action === 'refresh') {
      void refresh();
      return;
    }
    if (decision.action === 'wait') {
      pollTimer = setTimeout(() => schedulePoll(false), decision.delayMs);
    }
  };

  const cancelInflightRefresh = (): void => {
    refreshGeneration += 1;
    inflightRefresh = undefined;
    setRefreshingContext(false);
  };

  const refresh = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    if (inflightRefresh) {
      return inflightRefresh;
    }

    const generation = refreshGeneration;
    setRefreshingContext(true);

    const runRefresh = async (): Promise<void> => {
      lastAttemptAt = Date.now();
      const isCurrent = (): boolean => generation === refreshGeneration;

      const account = readCachedAccount();
      const storedSnapshot = context.globalState.get(SNAPSHOT_KEY);
      if (mustForgetSnapshot(storedSnapshot, account?.email)) {
        void forgetSnapshot();
      }
      const cachedSnapshot = snapshotForAccount(storedSnapshot, account?.email);

      if (!isCurrent()) {
        return;
      }

      if (!account) {
        treeDataProvider.setState(blockedViewState('missing_account'));
        consecutiveFailures = 0;
        return;
      }

      const session = await readSessionCookie();
      if (!isCurrent()) {
        return;
      }
      if (session.status !== 'ready') {
        const code = session.status === 'expired' ? 'expired_session' : 'missing_session';
        treeDataProvider.setState(blockedViewState(code, cachedSnapshot));
        consecutiveFailures = 0;
        return;
      }
      const cookie = session.value;

      const viewState = treeDataProvider.getState();
      const showsCachedFailure = viewState.kind === 'error' && viewState.snapshot !== undefined;
      if (viewState.kind !== 'ready' && !showsCachedFailure) {
        if (cachedSnapshot) {
          lastSuccessAt = Date.parse(cachedSnapshot.fetchedAt);
          treeDataProvider.setState({ kind: 'ready', snapshot: cachedSnapshot });
        } else if (viewState.kind === 'error') {
          treeDataProvider.setState({ kind: 'loading' });
        }
      }

      try {
        const freshSnapshot = await fetchUsageSnapshot({ cookie, account });
        if (!isCurrent()) {
          return;
        }
        await writeSnapshot(freshSnapshot);
        if (!isCurrent()) {
          return;
        }
        lastSuccessAt = Date.now();
        consecutiveFailures = 0;
        treeDataProvider.setState({ kind: 'ready', snapshot: freshSnapshot });
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        const nextState = errorViewState(error, cachedSnapshot);
        consecutiveFailures = blocksPolling(nextState.code) ? 0 : consecutiveFailures + 1;
        treeDataProvider.setState(nextState);
      }
    };

    inflightRefresh = Promise.resolve(
      vscode.window.withProgress({ location: { viewId: FuelTreeDataProvider.viewId } }, runRefresh),
    ).finally(() => {
      if (generation === refreshGeneration) {
        inflightRefresh = undefined;
        setRefreshingContext(false);
        schedulePoll(false);
      }
    });

    return inflightRefresh;
  };

  const openDashboard = async (): Promise<void> => {
    try {
      await vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
    } catch {
      void vscode.window.showErrorMessage('Impossible d’ouvrir cursor.com.');
    }
  };

  const shouldRefreshNow = (windowFocused: boolean): boolean => {
    const state = treeDataProvider.getState();
    return shouldRefreshOnFocus({
      now: Date.now(),
      windowFocused,
      ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
      ...(state.kind === 'error' && blocksPolling(state.code) ? { blockedCode: state.code } : {}),
    });
  };

  const treeView = vscode.window.createTreeView(FuelTreeDataProvider.viewId, {
    treeDataProvider,
  });
  treeDataProvider.attach(treeView);

  context.subscriptions.push(
    treeView,
    treeDataProvider,
    treeView.onDidChangeVisibility((event) => {
      if (event.visible) {
        schedulePoll(shouldRefreshNow(vscode.window.state.focused));
      }
    }),
    vscode.window.onDidChangeWindowState((windowState) => {
      schedulePoll(shouldRefreshNow(windowState.focused));
    }),
    vscode.commands.registerCommand('fuel.refresh', refresh),
    vscode.commands.registerCommand('fuel.openDashboard', openDashboard),
    {
      dispose() {
        disposed = true;
        cancelInflightRefresh();
        clearPollTimer();
      },
    },
  );

  setRefreshingContext(false);
  void refresh();
}

export function deactivate(): void {}

const BLOCKED_MESSAGES = {
  missing_account: 'Aucun compte Cursor connecté. Connecte-toi dans Cursor.',
  missing_session:
    'Session Cursor illisible. Autorise le trousseau « Cursor Safe Storage », puis Rafraîchir.',
  expired_session: 'Session Cursor expirée. Reviens sur cette fenêtre pour réessayer.',
} as const;

function blockedViewState(
  code: keyof typeof BLOCKED_MESSAGES,
  cachedSnapshot?: UsageSnapshot,
): ViewState {
  return {
    kind: 'error',
    code,
    message: BLOCKED_MESSAGES[code],
    ...(cachedSnapshot ? { snapshot: cachedSnapshot } : {}),
  };
}

function errorViewState(
  error: unknown,
  cachedSnapshot: UsageSnapshot | undefined,
): Extract<ViewState, { kind: 'error' }> {
  const { code, message } =
    error instanceof UsageError
      ? error
      : { code: 'unexpected' as const, message: 'Erreur inattendue. Nouvel essai automatique.' };
  return {
    kind: 'error',
    code,
    message,
    ...(cachedSnapshot ? { snapshot: cachedSnapshot } : {}),
  };
}
