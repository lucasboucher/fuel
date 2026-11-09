import * as vscode from 'vscode';
import { nextPoll, shouldRefreshOnFocus } from './poller.js';
import { ApiKeyStore, readCachedEmail, withTimeout } from './session.js';
import {
  fetchSpend,
  mustForgetSnapshot,
  type SpendSnapshot,
  snapshotForAccount,
  UsageError,
} from './usage.js';
import { FuelViewProvider, type ViewState } from './view.js';

const SNAPSHOT_KEY = 'fuel.snapshot';
const SECRET_TIMEOUT_MS = 2_000;
const CTX_REFRESHING = 'fuel.refreshing';

export function activate(context: vscode.ExtensionContext): void {
  const keys = ApiKeyStore.fromContext(context);
  const provider = new FuelViewProvider();
  let viewVisible = false;
  let lastSuccessAt: number | undefined;
  let lastAttemptAt: number | undefined;
  let consecutiveFailures = 0;
  let inflight: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshGeneration = 0;
  let disposed = false;
  let announceRequested = false;
  let announceStatus: vscode.Disposable | undefined;
  let hasApiKey: boolean | undefined;

  const setRefreshing = (value: boolean): void => {
    void vscode.commands.executeCommand('setContext', CTX_REFRESHING, value);
  };

  const clearAnnounceSpin = (): void => {
    announceStatus?.dispose();
    announceStatus = undefined;
  };

  const emailMissing = (): boolean => {
    const state = provider.getState();
    return state.kind === 'error' && state.code === 'missing_email';
  };

  // Each globalState write is echoed back and replaces the whole map.
  // Chain them so an older echo cannot drop a newer value.
  let snapshotWrite: Promise<void> = Promise.resolve();
  const writeSnapshot = (value: SpendSnapshot | undefined): Promise<void> => {
    const run = (): Thenable<void> => context.globalState.update(SNAPSHOT_KEY, value);
    snapshotWrite = snapshotWrite.then(run, run);
    return snapshotWrite;
  };
  const forgetSnapshot = (): Promise<void> => writeSnapshot(undefined);

  const schedule = (manual = false): void => {
    if (disposed) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }

    // A confirmed missing key never polls. Missing email waits for focus or Rafraîchir.
    if (hasApiKey === false || (!manual && emailMissing())) {
      return;
    }

    const decision = nextPoll({
      now: Date.now(),
      viewVisible,
      windowFocused: vscode.window.state.focused,
      consecutiveFailures,
      manual,
      ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
      ...(lastAttemptAt !== undefined ? { lastAttemptAt } : {}),
    });

    if (decision.action === 'fetch') {
      void refresh({ announce: false });
      return;
    }

    if (decision.action === 'wait') {
      timer = setTimeout(() => schedule(false), decision.delayMs);
    }
  };

  const invalidateInflight = (): void => {
    refreshGeneration += 1;
    inflight = undefined;
    announceRequested = false;
    clearAnnounceSpin();
    setRefreshing(false);
  };

  const completeAnnounce = (outcome: 'ok' | 'error'): void => {
    if (!announceRequested) {
      return;
    }
    clearAnnounceSpin();
    announceRequested = false;
    if (outcome === 'ok') {
      vscode.window.setStatusBarMessage('$(check) Cursor Fuel actualisé', 2_500);
      return;
    }
    vscode.window.setStatusBarMessage('$(error) Cursor Fuel : échec du rafraîchissement', 3_000);
  };

  const refresh = async (options: { announce?: boolean } = {}): Promise<void> => {
    if (disposed) {
      return;
    }

    if (options.announce === true) {
      announceRequested = true;
      clearAnnounceSpin();
      announceStatus = vscode.window.setStatusBarMessage('$(sync~spin) Cursor Fuel…');
    }

    if (inflight) {
      return inflight;
    }

    const generation = refreshGeneration;
    setRefreshing(true);

    inflight = (async () => {
      lastAttemptAt = Date.now();
      const isCurrent = (): boolean => generation === refreshGeneration;

      let apiKey: string | undefined;
      let vaultFailed = false;
      try {
        apiKey = await withTimeout(keys.get(), SECRET_TIMEOUT_MS);
      } catch {
        vaultFailed = true;
      }

      if (!isCurrent()) {
        return;
      }

      const email = safeReadEmail();
      const cached = context.globalState.get(SNAPSHOT_KEY);
      if (mustForgetSnapshot(cached, email)) {
        void forgetSnapshot();
      }
      const snapshot = snapshotForAccount(cached, email);

      if (vaultFailed) {
        provider.setState(blockedState('vault', snapshot));
        consecutiveFailures += 1;
        completeAnnounce('error');
        return;
      }

      hasApiKey = Boolean(apiKey);
      if (!apiKey) {
        provider.setState({ kind: 'needs_key' });
        consecutiveFailures = 0;
        completeAnnounce('error');
        return;
      }

      if (!email) {
        provider.setState(blockedState('missing_email'));
        consecutiveFailures = 0;
        completeAnnounce('error');
        return;
      }

      if (!isCurrent()) {
        return;
      }

      if (provider.getState().kind !== 'ready') {
        if (snapshot) {
          const parsed = Date.parse(snapshot.fetchedAt);
          lastSuccessAt = Number.isFinite(parsed) ? parsed : undefined;
          provider.setState({ kind: 'ready', snapshot });
        } else {
          provider.setState({ kind: 'loading', email });
        }
      }

      try {
        const fresh = await fetchSpend({ apiKey, email });
        if (!isCurrent()) {
          return;
        }
        await writeSnapshot(fresh);
        if (!isCurrent()) {
          return;
        }
        lastSuccessAt = Date.now();
        consecutiveFailures = 0;
        provider.setState({ kind: 'ready', snapshot: fresh });
        completeAnnounce('ok');
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        consecutiveFailures += 1;
        provider.setState(toErrorState(error, snapshot));
        completeAnnounce('error');
      }
    })().finally(() => {
      if (generation === refreshGeneration) {
        announceRequested = false;
        clearAnnounceSpin();
        inflight = undefined;
        setRefreshing(false);
        if (!disposed) {
          schedule(false);
        }
      }
    });

    return inflight;
  };

  const reportCommandError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : 'Erreur inattendue.';
    void vscode.window.showErrorMessage(`Cursor Fuel : ${message}`);
  };

  const runCommand = (task: () => Promise<void>): void => {
    void task().catch(reportCommandError);
  };

  const setApiKey = async (): Promise<void> => {
    const value = await vscode.window.showInputBox({
      title: 'Cursor Fuel',
      prompt: 'Colle la clé d’API d’équipe Cursor',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'crsr_… ou grok_…',
    });
    if (!value?.trim()) {
      return;
    }
    await keys.set(value);
    hasApiKey = true;
    consecutiveFailures = 0;
    invalidateInflight();
    await refresh({ announce: true });
  };

  const clearApiKey = async (): Promise<void> => {
    invalidateInflight();
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    await keys.clear();
    hasApiKey = false;
    await forgetSnapshot();
    lastSuccessAt = undefined;
    lastAttemptAt = undefined;
    consecutiveFailures = 0;
    provider.setState({ kind: 'needs_key' });
  };

  const refreshBecauseFocused = (focused: boolean): boolean => {
    if (!viewVisible || !focused) {
      return false;
    }
    if (emailMissing()) {
      return true;
    }
    return shouldRefreshOnFocus({
      now: Date.now(),
      viewVisible,
      windowFocused: focused,
      ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
    });
  };

  const treeView = vscode.window.createTreeView(FuelViewProvider.viewType, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  provider.attach(treeView);

  context.subscriptions.push(
    treeView,
    provider,
    treeView.onDidChangeVisibility((event) => {
      viewVisible = event.visible;
      if (refreshBecauseFocused(vscode.window.state.focused)) {
        schedule(true);
        return;
      }
      schedule(false);
    }),
    vscode.commands.registerCommand('fuel.refresh', () =>
      runCommand(() => refresh({ announce: true })),
    ),
    vscode.commands.registerCommand('fuel.setApiKey', () => runCommand(setApiKey)),
    vscode.commands.registerCommand('fuel.clearApiKey', () => runCommand(clearApiKey)),
    vscode.window.onDidChangeWindowState((state) => {
      if (refreshBecauseFocused(state.focused)) {
        schedule(true);
        return;
      }
      schedule(false);
    }),
    {
      dispose() {
        disposed = true;
        invalidateInflight();
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      },
    },
  );

  viewVisible = treeView.visible;
  setRefreshing(false);
  void refresh().catch(reportCommandError);
}

export function deactivate(): void {}

function safeReadEmail(): string | undefined {
  try {
    return readCachedEmail();
  } catch {
    return undefined;
  }
}

const BLOCKED_MESSAGE = {
  vault: 'Impossible de lire la clé d’API dans le coffre Cursor.',
  missing_email: 'Connecte-toi à Cursor pour retrouver ton e-mail local.',
} as const;

function blockedState(code: keyof typeof BLOCKED_MESSAGE, snapshot?: SpendSnapshot): ViewState {
  return {
    kind: 'error',
    code,
    message: BLOCKED_MESSAGE[code],
    ...(snapshot ? { snapshot } : {}),
  };
}

function toErrorState(error: unknown, snapshot: SpendSnapshot | undefined): ViewState {
  if (error instanceof UsageError) {
    return {
      kind: 'error',
      code: error.code,
      message: error.message,
      ...(snapshot ? { snapshot } : {}),
    };
  }
  return {
    kind: 'error',
    code: 'network',
    message: 'Impossible de récupérer la dépense.',
    ...(snapshot ? { snapshot } : {}),
  };
}
