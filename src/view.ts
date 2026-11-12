import { basename } from 'node:path';
import * as vscode from 'vscode';
import {
  type ConversationSpend,
  composerIdFromText,
  conversationIdForExactTitle,
  formatModelLabel,
  groupByProject,
  type ModelSpend,
  matchConversationId,
  type TokenBreakdown,
  totalTokens,
} from './conversations.js';
import { UNASSIGNED_PROJECT_NAME } from './transcripts.js';
import type { UsageSnapshot } from './usage.js';
import { badgePercentFor, type ViewState } from './view-state.js';

const ACTIVE_ICON_COLOR = new vscode.ThemeColor('activityBarBadge.background');

type FuelNode = {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: vscode.ThemeIcon;
  collapsed?: boolean;
  children?: FuelNode[];
};

type ActiveContext = {
  projectName?: string;
  conversationId?: string;
};

export class FuelTreeDataProvider implements vscode.TreeDataProvider<FuelNode>, vscode.Disposable {
  static readonly viewId = 'fuel.view';

  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    FuelNode | undefined | null
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private state: ViewState = { kind: 'loading' };
  private treeView?: vscode.TreeView<FuelNode>;
  private lastActiveKey = '';

  attach(treeView: vscode.TreeView<FuelNode>): void {
    this.treeView = treeView;
    this.syncTreeView();
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  setState(state: ViewState): void {
    this.state = state;
    this.lastActiveKey = activeContextKey(this.activeContext());
    this.onDidChangeTreeDataEmitter.fire(undefined);
    this.syncTreeView();
  }

  /** Rebuild icons when the focused chat or workspace folder changes (no network). */
  refreshActiveIcons(): void {
    const key = activeContextKey(this.activeContext());
    if (key === this.lastActiveKey) {
      return;
    }
    this.lastActiveKey = key;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getState(): ViewState {
    return this.state;
  }

  getTreeItem(node: FuelNode): vscode.TreeItem {
    const collapsibleState = node.children?.length
      ? node.collapsed
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsibleState);
    item.id = node.id;
    if (node.description !== undefined) {
      item.description = node.description;
    }
    if (node.icon) {
      item.iconPath = node.icon;
    }
    if (node.tooltip !== undefined) {
      item.tooltip = node.tooltip;
    }
    return item;
  }

  getChildren(node?: FuelNode): FuelNode[] {
    if (node) {
      return node.children ?? [];
    }
    const snapshot = shownSnapshot(this.state);
    return snapshot ? snapshotNodes(snapshot, this.activeContext()) : [];
  }

  private activeContext(): ActiveContext {
    return readActiveContext(shownSnapshot(this.state)?.conversations ?? []);
  }

  private syncTreeView(): void {
    if (!this.treeView) {
      return;
    }

    const badgePercent = badgePercentFor(this.state);
    if (badgePercent !== undefined) {
      const value = Math.round(badgePercent);
      this.treeView.badge = { value, tooltip: `${formatPercent(value)} de l’usage inclus` };
    } else {
      this.treeView.badge = undefined;
    }

    this.treeView.message = viewMessage(this.state);
  }
}

function readActiveContext(conversations: readonly ConversationSpend[]): ActiveContext {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const projectName = folder ? basename(folder) || undefined : undefined;
  const conversationId = activeComposerIdFromTabs(conversations);
  return {
    ...(projectName ? { projectName } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

function activeContextKey(active: ActiveContext): string {
  return `${active.projectName ?? ''}\0${active.conversationId ?? ''}`;
}

function activeComposerIdFromTabs(conversations: readonly ConversationSpend[]): string | undefined {
  const tabs = activeTabsInPriorityOrder();
  for (const tab of tabs) {
    const fromInput = matchConversationId(composerIdFromTabInput(tab.input), conversations);
    if (fromInput) {
      return fromInput;
    }
  }
  for (const tab of tabs) {
    const fromLabel = conversationIdForExactTitle(tab.label, conversations);
    if (fromLabel) {
      return fromLabel;
    }
  }
  return undefined;
}

function activeTabsInPriorityOrder(): vscode.Tab[] {
  const seen = new Set<vscode.Tab>();
  const ordered: vscode.Tab[] = [];
  const push = (tab: vscode.Tab | undefined): void => {
    if (!tab || seen.has(tab)) {
      return;
    }
    seen.add(tab);
    ordered.push(tab);
  };
  push(vscode.window.tabGroups.activeTabGroup.activeTab);
  for (const group of vscode.window.tabGroups.all) {
    push(group.activeTab);
  }
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.isActive) {
        push(tab);
      }
    }
  }
  return ordered;
}

function composerIdFromTabInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  if (input instanceof vscode.TabInputCustom) {
    return composerIdFromText(input.uri.toString()) ?? composerIdFromText(input.viewType);
  }
  const record = input as Record<string, unknown>;
  for (const key of ['composerId', 'agentId', 'conversationId']) {
    const value = record[key];
    if (typeof value === 'string') {
      const id = composerIdFromText(value);
      if (id) {
        return id;
      }
    }
  }
  if (record.uri instanceof vscode.Uri) {
    return composerIdFromText(record.uri.toString());
  }
  try {
    return composerIdFromText(JSON.stringify(record));
  } catch {
    return undefined;
  }
}

function shownSnapshot(state: ViewState): UsageSnapshot | undefined {
  return state.kind === 'loading' ? undefined : state.snapshot;
}

function viewMessage(state: ViewState): string {
  if (state.kind === 'loading') {
    return 'Chargement…';
  }
  if (state.kind === 'error') {
    return state.message;
  }
  return '';
}

function snapshotNodes(snapshot: UsageSnapshot, active: ActiveContext): FuelNode[] {
  const teamNodes: FuelNode[] = [
    {
      id: 'team-name',
      label: snapshot.teamName,
      icon: new vscode.ThemeIcon('organization'),
    },
    {
      id: 'team-on-demand',
      label: 'À la demande',
      description: snapshot.teamOnDemandEnabled ? 'Activé' : 'Désactivé',
      icon: new vscode.ThemeIcon('zap'),
    },
  ];

  if (snapshot.teamOnDemandEnabled) {
    teamNodes.push({
      id: 'team-spend-limit',
      label: 'Limite d’équipe',
      description:
        snapshot.teamSpendLimitDollars === null
          ? 'Sans limite'
          : formatDollars(snapshot.teamSpendLimitDollars),
      icon: new vscode.ThemeIcon('target'),
    });
  }

  const usageNodes: FuelNode[] = [
    {
      id: 'usage-total',
      label: 'Total',
      description: formatPercent(snapshot.totalPercentUsed),
      icon: new vscode.ThemeIcon('dashboard'),
    },
    {
      id: 'usage-cursor-models',
      label: 'Modèles Cursor',
      description: formatPercent(snapshot.cursorModelsPercentUsed),
      icon: new vscode.ThemeIcon('sparkle'),
    },
    {
      id: 'usage-other-models',
      label: 'Autres modèles',
      description: formatPercent(snapshot.otherModelsPercentUsed),
      icon: new vscode.ThemeIcon('symbol-misc'),
    },
  ];

  const spendNodes: FuelNode[] = [
    {
      id: 'spend-overall',
      label: 'Total',
      description: formatDollars(snapshot.overallSpendDollars),
      icon: new vscode.ThemeIcon('graph'),
    },
    {
      id: 'spend-included',
      label: 'Incluse',
      description: formatDollars(snapshot.includedSpendDollars),
      icon: new vscode.ThemeIcon('pass'),
    },
    {
      id: 'spend-on-demand',
      label: 'À la demande',
      description: formatDollars(snapshot.onDemandSpendDollars),
      icon: new vscode.ThemeIcon('flame'),
    },
  ];

  const cycleNodes: FuelNode[] = [
    {
      id: 'cycle-start',
      label: 'Début',
      description: formatDateTime(snapshot.cycleStart),
      icon: new vscode.ThemeIcon('calendar'),
    },
    {
      id: 'cycle-fetched-at',
      label: 'Mis à jour',
      description: formatDateTime(snapshot.fetchedAt),
      icon: new vscode.ThemeIcon('clock'),
    },
    {
      id: 'cycle-end',
      label: 'Fin',
      description: formatDateTime(snapshot.cycleEnd),
      icon: new vscode.ThemeIcon('milestone'),
    },
  ];

  const conversationNodes: FuelNode[] = groupByProject(snapshot.conversations).map((project) => {
    const projectIconId = project.name === UNASSIGNED_PROJECT_NAME ? 'question' : 'repo';
    const projectActive =
      project.name !== UNASSIGNED_PROJECT_NAME &&
      active.projectName !== undefined &&
      project.name === active.projectName;
    return {
      id: `project-${project.name}`,
      label: project.name,
      description: formatDollars(project.chargedDollars),
      icon: themeIcon(projectIconId, projectActive),
      collapsed: true,
      children: project.conversations.map((conversation) => {
        const conversationActive =
          active.conversationId !== undefined && conversation.id === active.conversationId;
        return {
          id: `conversation-${conversation.id}`,
          label: conversation.title,
          description: formatDollars(conversation.chargedDollars),
          tooltip: formatDateTime(conversation.lastEventAt),
          icon: themeIcon(
            conversationIconId(conversation.id, conversation.title),
            conversationActive,
          ),
          collapsed: true,
          children: modelNodes(conversation.id, conversation.models),
        };
      }),
    };
  });

  return [
    {
      id: 'identity',
      label: snapshot.displayName,
      description: snapshot.email,
      icon: new vscode.ThemeIcon('account'),
      children: teamNodes,
    },
    {
      id: 'group-usage',
      label: 'Usage inclus',
      icon: new vscode.ThemeIcon('pie-chart'),
      children: usageNodes,
    },
    {
      id: 'group-spend',
      label: 'Dépenses',
      icon: new vscode.ThemeIcon('credit-card'),
      children: spendNodes,
    },
    {
      id: 'group-conversations',
      label: 'Conversations',
      icon: new vscode.ThemeIcon('library'),
      children: conversationNodes,
      ...(snapshot.conversations.length === 0 ? { description: 'Aucune' } : {}),
    },
    {
      id: 'group-cycle',
      label: 'Cycle',
      icon: new vscode.ThemeIcon('history'),
      children: cycleNodes,
    },
  ];
}

function themeIcon(id: string, active: boolean): vscode.ThemeIcon {
  return active ? new vscode.ThemeIcon(id, ACTIVE_ICON_COLOR) : new vscode.ThemeIcon(id);
}

const DOLLARS_FORMAT = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
});
const PERCENT_FORMAT = new Intl.NumberFormat('fr-FR', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

function conversationIconId(id: string, title: string): string {
  if (id.startsWith('sand-subagent-')) {
    return 'copilot-large';
  }
  if (title.startsWith('Inconnu (')) {
    return 'report';
  }
  return 'comment-discussion';
}

function modelNodes(conversationId: string, models: readonly ModelSpend[]): FuelNode[] {
  return models.map((model) => {
    const modelKey = treeIdSegment(model.model);
    const label = formatModelLabel(model.model);
    const tokenTotal = totalTokens(model.tokens);
    const emptyShell = tokenTotal === 0 && model.chargedDollars === 0;
    const node: FuelNode = {
      id: `conversation-${conversationId}-model-${modelKey}`,
      label,
      icon: new vscode.ThemeIcon('chip'),
    };
    if (!emptyShell) {
      node.description = formatDollars(model.chargedDollars);
      node.tooltip =
        label === model.model
          ? formatTokens(tokenTotal)
          : `${model.model} · ${formatTokens(tokenTotal)}`;
    } else if (label !== model.model) {
      node.tooltip = model.model;
    }
    if (tokenTotal > 0) {
      node.collapsed = true;
      node.children = tokenNodes(`conversation-${conversationId}-model-${modelKey}`, model.tokens);
    }
    return node;
  });
}

function tokenNodes(prefix: string, tokens: TokenBreakdown): FuelNode[] {
  return [
    {
      id: `${prefix}-cache-read`,
      label: 'Lecture cache',
      description: formatTokens(tokens.cacheRead),
      icon: new vscode.ThemeIcon('archive'),
    },
    {
      id: `${prefix}-cache-write`,
      label: 'Écriture cache',
      description: formatTokens(tokens.cacheWrite),
      icon: new vscode.ThemeIcon('save'),
    },
    {
      id: `${prefix}-input`,
      label: 'Entrée',
      description: formatTokens(tokens.input),
      icon: new vscode.ThemeIcon('arrow-down'),
    },
    {
      id: `${prefix}-output`,
      label: 'Sortie',
      description: formatTokens(tokens.output),
      icon: new vscode.ThemeIcon('arrow-up'),
    },
    {
      id: `${prefix}-total`,
      label: 'Total',
      description: formatTokens(totalTokens(tokens)),
      icon: new vscode.ThemeIcon('symbol-number'),
    },
  ];
}

function treeIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'unknown';
}

function formatDollars(value: number): string {
  return DOLLARS_FORMAT.format(value);
}

const TOKENS_FORMAT = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

function formatTokens(value: number): string {
  return TOKENS_FORMAT.format(value);
}

function formatPercent(value: number): string {
  return PERCENT_FORMAT.format(value / 100);
}

function formatDateTime(value: string): string {
  return DATE_TIME_FORMAT.format(new Date(value));
}
