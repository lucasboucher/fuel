import * as vscode from 'vscode';
import { nextPoll, shouldRefreshOnFocus } from './poller.js';
import { ApiKeyStore, readCachedEmail, withTimeout } from './session.js';
import { fetchSpend, type SpendSnapshot, UsageError } from './usage.js';
import { FuelViewProvider, type ViewState } from './view.js';

const SNAPSHOT_KEY = 'fuel.snapshot';
const SECRET_TIMEOUT_MS = 2_000;

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

  const schedule = (manual = false): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }

    // No key yet: wait for the user, don't spin the poller.
    if (!manual && provider.getState().kind === 'needs_key') {
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

  const refresh = async (options: { announce?: boolean } = {}): Promise<void> => {
    if (inflight) {
      return inflight;
    }

    const announce = options.announce === true;
    const generation = refreshGeneration;
    let status: vscode.Disposable | undefined;
    if (announce) {
      status = vscode.window.setStatusBarMessage('$(sync~spin) Cursor Fuel…');
    }

    inflight = (async () => {
      lastAttemptAt = Date.now();
      const cached = context.globalState.get<SpendSnapshot>(SNAPSHOT_KEY);
      const isCurrent = (): boolean => generation === refreshGeneration;

      let apiKey: string | undefined;
      try {
        apiKey = await withTimeout(keys.get(), SECRET_TIMEOUT_MS);
      } catch {
        if (!isCurrent()) {
          return;
        }
        provider.setState({
          kind: 'error',
          code: 'vault',
          message: 'Impossible de lire la clé d’API dans le coffre Cursor.',
          ...(cached ? { snapshot: cached } : {}),
        });
        consecutiveFailures += 1;
        return;
      }

      if (!isCurrent()) {
        return;
      }

      if (!apiKey) {
        provider.setState({ kind: 'needs_key' });
        consecutiveFailures = 0;
        return;
      }

      const email = safeReadEmail();
      if (!email) {
        provider.setState({
          kind: 'error',
          code: 'missing_email',
          message: 'Connecte-toi à Cursor pour retrouver ton e-mail local.',
          ...(cached ? { snapshot: cached } : {}),
        });
        consecutiveFailures += 1;
        return;
      }

      if (provider.getState().kind !== 'ready') {
        provider.setState({ kind: 'loading', email });
      }

      try {
        const snapshot = await fetchSpend({ apiKey, email });
        if (!isCurrent()) {
          return;
        }
        await context.globalState.update(SNAPSHOT_KEY, snapshot);
        lastSuccessAt = Date.now();
        consecutiveFailures = 0;
        provider.setState({ kind: 'ready', snapshot });
        if (announce) {
          vscode.window.setStatusBarMessage('$(check) Cursor Fuel actualisé', 2_500);
        }
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        consecutiveFailures += 1;
        provider.setState(
          toErrorState(error, context.globalState.get<SpendSnapshot>(SNAPSHOT_KEY)),
        );
        if (announce) {
          vscode.window.setStatusBarMessage(
            '$(error) Cursor Fuel : échec du rafraîchissement',
            3_000,
          );
        }
      }
    })().finally(() => {
      status?.dispose();
      if (generation === refreshGeneration) {
        inflight = undefined;
        schedule(false);
      }
    });

    return inflight;
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
    consecutiveFailures = 0;
    await refresh({ announce: true });
  };

  const clearApiKey = async (): Promise<void> => {
    refreshGeneration += 1;
    inflight = undefined;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    await keys.clear();
    await context.globalState.update(SNAPSHOT_KEY, undefined);
    lastSuccessAt = undefined;
    lastAttemptAt = undefined;
    consecutiveFailures = 0;
    provider.setState({ kind: 'needs_key' });
  };

  const cached = context.globalState.get<SpendSnapshot>(SNAPSHOT_KEY);
  if (cached) {
    lastSuccessAt = Date.parse(cached.fetchedAt);
    provider.setState({ kind: 'ready', snapshot: cached });
  } else {
    // Avoid an infinite "Chargement…" if secrets/sqlite are slow: assume key needed
    // until refresh proves otherwise.
    provider.setState({ kind: 'needs_key' });
  }

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
      if (
        viewVisible &&
        shouldRefreshOnFocus({
          now: Date.now(),
          viewVisible,
          windowFocused: vscode.window.state.focused,
          ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
        })
      ) {
        schedule(true);
        return;
      }
      schedule(false);
    }),
    vscode.commands.registerCommand('fuel.refresh', () => refresh({ announce: true })),
    vscode.commands.registerCommand('fuel.setApiKey', () => setApiKey()),
    vscode.commands.registerCommand('fuel.clearApiKey', () => clearApiKey()),
    vscode.window.onDidChangeWindowState((state) => {
      if (
        state.focused &&
        shouldRefreshOnFocus({
          now: Date.now(),
          viewVisible,
          windowFocused: true,
          ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
        })
      ) {
        schedule(true);
        return;
      }
      schedule(false);
    }),
    {
      dispose() {
        if (timer) {
          clearTimeout(timer);
        }
      },
    },
  );

  viewVisible = treeView.visible;
  schedule(true);
}

export function deactivate(): void {}

function safeReadEmail(): string | undefined {
  try {
    return readCachedEmail();
  } catch {
    return undefined;
  }
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
