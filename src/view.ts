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
  UNATTACHED_CONVERSATION_ID,
} from './conversations.js';
import { UNASSIGNED_PROJECT_NAME } from './transcripts.js';
import type { UsageSnapshot } from './usage.js';
import { badgePercentFor, type ViewState } from './view-state.js';

const ACTIVE_ICON_COLOR = new vscode.ThemeColor('activityBarBadge.background');
const TREE_EXPANDED_KEY = 'fuel.treeExpanded';
const CONVERSATION_CONTEXT = 'conversation';
const COPYABLE_CONTEXT = 'hasCopy';

/** Hover help for short field labels (replaces the default label-only tooltip). */
const FIELD_HELP = {
  teamOnDemand: 'Indique si ton équipe autorise le dépassement du forfait inclus.',
  teamSpendLimit: 'Plafond de dépense à la demande pour toute l’équipe, ou sans limite.',
  usageTotal: 'Part du forfait inclus déjà consommée sur ce cycle.',
  usageCursorModels: 'Part du forfait inclus consommée par les modèles Cursor (Auto, etc.).',
  usageOtherModels: 'Part du forfait inclus consommée par les modèles hors Cursor.',
  spendOverall: 'Dépenses du cycle : forfait inclus + à la demande, en dollars.',
  spendIncluded: 'Montant déjà consommé sur le forfait inclus, en dollars.',
  spendOnDemand: 'Montant facturé hors forfait inclus, en dollars.',
  cycleStart: 'Début du cycle de facturation Cursor.',
  cycleFetchedAt: 'Dernière fois où Fuel a rafraîchi ces chiffres.',
  cycleEnd: 'Fin du cycle de facturation Cursor.',
  tokenCacheRead: 'Tokens relus depuis le cache de contexte.',
  tokenCacheWrite: 'Tokens écrits dans le cache de contexte.',
  tokenInput: 'Tokens d’entrée hors cache.',
  tokenOutput: 'Tokens générés en réponse.',
  tokenTotal: 'Somme des tokens lecture cache, écriture cache, entrée et sortie.',
} as const;

type FuelNode = {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: vscode.ThemeIcon;
  collapsed?: boolean;
  contextValue?: string;
  composerId?: string;
  copyText?: string;
  children?: FuelNode[];
};

export function composerIdFromOpenTarget(target: unknown): string | undefined {
  if (!target || typeof target !== 'object') {
    return undefined;
  }
  const composerId = (target as FuelNode).composerId;
  return typeof composerId === 'string' && composerId.length > 0 ? composerId : undefined;
}

export function copyTextFromTarget(
  target: unknown,
  lookup?: (id: string) => string | undefined,
): string | undefined {
  if (!target || typeof target !== 'object') {
    return undefined;
  }
  const node = target as FuelNode;
  if (typeof node.copyText === 'string' && node.copyText.length > 0) {
    return node.copyText;
  }
  if (typeof node.id === 'string' && lookup) {
    return lookup(node.id);
  }
  return undefined;
}

function joinContext(...parts: Array<string | undefined>): string | undefined {
  // Space-separated tags for viewItem =~ /tag/ when clauses.
  const joined = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return joined.length > 0 ? joined.join(' ') : undefined;
}

function withCopyText(node: FuelNode, copyText: string): FuelNode {
  const contextValue = joinContext(node.contextValue, COPYABLE_CONTEXT);
  return {
    ...node,
    copyText,
    ...(contextValue !== undefined ? { contextValue } : {}),
  };
}

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
  private roots: FuelNode[] = [];
  private readonly expandedRootIds = new Set<string>();
  private readonly treeViewListeners: vscode.Disposable[] = [];

  attach(treeView: vscode.TreeView<FuelNode>): void {
    this.treeView = treeView;
    for (const listener of this.treeViewListeners) {
      listener.dispose();
    }
    this.treeViewListeners.length = 0;
    this.treeViewListeners.push(
      treeView.onDidExpandElement((event) => {
        if (this.isCollapsibleRootId(event.element.id)) {
          this.expandedRootIds.add(event.element.id);
          this.syncExpandedContext();
        }
      }),
      treeView.onDidCollapseElement((event) => {
        if (this.isCollapsibleRootId(event.element.id)) {
          this.expandedRootIds.delete(event.element.id);
          this.syncExpandedContext();
        }
      }),
    );
    this.syncTreeView();
    this.syncExpandedContext();
  }

  dispose(): void {
    for (const listener of this.treeViewListeners) {
      listener.dispose();
    }
    this.treeViewListeners.length = 0;
    this.onDidChangeTreeDataEmitter.dispose();
  }

  copyTextForId(id: string): string | undefined {
    return findNodeById(this.roots, id)?.copyText;
  }

  setState(state: ViewState): void {
    this.state = state;
    this.lastActiveKey = activeContextKey(this.activeContext());
    this.rebuildRoots();
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
    this.rebuildRoots();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getState(): ViewState {
    return this.state;
  }

  /** Open top-level groups only (projects stay collapsed). */
  async expandAll(): Promise<void> {
    if (!this.treeView) {
      return;
    }
    await this.focusView();
    await vscode.commands.executeCommand('list.collapseAll');
    this.expandedRootIds.clear();
    for (const root of this.roots) {
      if (!root.children?.length) {
        continue;
      }
      try {
        await this.treeView.reveal(root, { expand: true, focus: false, select: false });
        this.expandedRootIds.add(root.id);
      } catch {
        // Tree may have refreshed while we were expanding.
      }
    }
    this.syncExpandedContext();
  }

  async collapseAll(): Promise<void> {
    await this.focusView();
    await vscode.commands.executeCommand('list.collapseAll');
    this.expandedRootIds.clear();
    this.syncExpandedContext();
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
    if (node.contextValue !== undefined) {
      item.contextValue = node.contextValue;
    }
    return item;
  }

  getChildren(node?: FuelNode): FuelNode[] {
    if (node) {
      return node.children ?? [];
    }
    return this.roots;
  }

  private rebuildRoots(): void {
    const hadRoots = this.roots.length > 0;
    const snapshot = shownSnapshot(this.state);
    this.roots = snapshot ? snapshotNodes(snapshot, this.activeContext()) : [];

    const rootIds = new Set(this.collapsibleRootIds());
    for (const id of [...this.expandedRootIds]) {
      if (!rootIds.has(id)) {
        this.expandedRootIds.delete(id);
      }
    }
    // First paint: top groups use Expanded in getTreeItem.
    if (!hadRoots && this.roots.length > 0 && this.expandedRootIds.size === 0) {
      for (const id of rootIds) {
        this.expandedRootIds.add(id);
      }
    }
    this.syncExpandedContext();
  }

  private collapsibleRootIds(): string[] {
    return this.roots.filter((node) => node.children?.length).map((node) => node.id);
  }

  private isCollapsibleRootId(id: string): boolean {
    return this.collapsibleRootIds().includes(id);
  }

  private async focusView(): Promise<void> {
    try {
      await vscode.commands.executeCommand(`${FuelTreeDataProvider.viewId}.focus`);
    } catch {
      // View may already be focused.
    }
  }

  private syncExpandedContext(): void {
    const rootIds = this.collapsibleRootIds();
    const expanded = rootIds.length > 0 && rootIds.every((id) => this.expandedRootIds.has(id));
    void vscode.commands.executeCommand('setContext', TREE_EXPANDED_KEY, expanded);
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

function findNodeById(nodes: readonly FuelNode[], id: string): FuelNode | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    if (node.children?.length) {
      const found = findNodeById(node.children, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
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
  const onDemandLabel = snapshot.teamOnDemandEnabled ? 'Activé' : 'Désactivé';
  const teamLimitLabel =
    snapshot.teamSpendLimitDollars === null
      ? 'Sans limite'
      : formatDollars(snapshot.teamSpendLimitDollars);

  const teamNodes: FuelNode[] = [
    withCopyText(
      {
        id: 'team-name',
        label: snapshot.teamName,
        icon: new vscode.ThemeIcon('organization'),
      },
      snapshot.teamName,
    ),
    withCopyText(
      {
        id: 'team-on-demand',
        label: 'À la demande',
        description: onDemandLabel,
        tooltip: FIELD_HELP.teamOnDemand,
        icon: new vscode.ThemeIcon('zap'),
      },
      onDemandLabel,
    ),
  ];

  if (snapshot.teamOnDemandEnabled) {
    teamNodes.push(
      withCopyText(
        {
          id: 'team-spend-limit',
          label: 'Limite d’équipe',
          description: teamLimitLabel,
          tooltip: FIELD_HELP.teamSpendLimit,
          icon: new vscode.ThemeIcon('target'),
        },
        teamLimitLabel,
      ),
    );
  }

  const usageTotal = formatPercent(snapshot.totalPercentUsed);
  const usageCursor = formatPercent(snapshot.cursorModelsPercentUsed);
  const usageOther = formatPercent(snapshot.otherModelsPercentUsed);
  const usageNodes: FuelNode[] = [
    withCopyText(
      {
        id: 'usage-total',
        label: 'Total',
        description: usageTotal,
        tooltip: FIELD_HELP.usageTotal,
        icon: new vscode.ThemeIcon('dashboard'),
      },
      usageTotal,
    ),
    withCopyText(
      {
        id: 'usage-cursor-models',
        label: 'Modèles Cursor',
        description: usageCursor,
        tooltip: FIELD_HELP.usageCursorModels,
        icon: new vscode.ThemeIcon('sparkle'),
      },
      usageCursor,
    ),
    withCopyText(
      {
        id: 'usage-other-models',
        label: 'Autres modèles',
        description: usageOther,
        tooltip: FIELD_HELP.usageOtherModels,
        icon: new vscode.ThemeIcon('symbol-misc'),
      },
      usageOther,
    ),
  ];

  const spendOverall = formatDollars(snapshot.overallSpendDollars);
  const spendIncluded = formatDollars(snapshot.includedSpendDollars);
  const spendOnDemand = formatDollars(snapshot.onDemandSpendDollars);
  const spendNodes: FuelNode[] = [
    withCopyText(
      {
        id: 'spend-overall',
        label: 'Total',
        description: spendOverall,
        tooltip: FIELD_HELP.spendOverall,
        icon: new vscode.ThemeIcon('graph'),
      },
      spendOverall,
    ),
    withCopyText(
      {
        id: 'spend-included',
        label: 'Incluse',
        description: spendIncluded,
        tooltip: FIELD_HELP.spendIncluded,
        icon: new vscode.ThemeIcon('pass'),
      },
      spendIncluded,
    ),
    withCopyText(
      {
        id: 'spend-on-demand',
        label: 'À la demande',
        description: spendOnDemand,
        tooltip: FIELD_HELP.spendOnDemand,
        icon: new vscode.ThemeIcon('flame'),
      },
      spendOnDemand,
    ),
  ];

  const cycleStart = formatDateTime(snapshot.cycleStart);
  const cycleFetched = formatDateTime(snapshot.fetchedAt);
  const cycleEnd = formatDateTime(snapshot.cycleEnd);
  const cycleNodes: FuelNode[] = [
    withCopyText(
      {
        id: 'cycle-start',
        label: 'Début',
        description: cycleStart,
        tooltip: FIELD_HELP.cycleStart,
        icon: new vscode.ThemeIcon('calendar'),
      },
      cycleStart,
    ),
    withCopyText(
      {
        id: 'cycle-fetched-at',
        label: 'Mis à jour',
        description: cycleFetched,
        tooltip: FIELD_HELP.cycleFetchedAt,
        icon: new vscode.ThemeIcon('clock'),
      },
      cycleFetched,
    ),
    withCopyText(
      {
        id: 'cycle-end',
        label: 'Fin',
        description: cycleEnd,
        tooltip: FIELD_HELP.cycleEnd,
        icon: new vscode.ThemeIcon('milestone'),
      },
      cycleEnd,
    ),
  ];

  const conversationNodes: FuelNode[] = groupByProject(snapshot.conversations).map((project) => {
    const projectIconId = project.name === UNASSIGNED_PROJECT_NAME ? 'question' : 'repo';
    const projectActive =
      project.name !== UNASSIGNED_PROJECT_NAME &&
      active.projectName !== undefined &&
      project.name === active.projectName;
    const projectCharged = formatDollars(project.chargedDollars);
    return withCopyText(
      {
        id: `project-${project.name}`,
        label: project.name,
        description: projectCharged,
        icon: themeIcon(projectIconId, projectActive),
        collapsed: true,
        children: project.conversations.map((conversation) => {
          const conversationActive =
            active.conversationId !== undefined && conversation.id === active.conversationId;
          const charged = formatDollars(conversation.chargedDollars);
          return withCopyText(
            {
              id: `conversation-${conversation.id}`,
              label: conversation.title,
              description: charged,
              tooltip: formatDateTime(conversation.lastEventAt),
              icon: themeIcon(
                conversationIconId(conversation.id, conversation.title),
                conversationActive,
              ),
              collapsed: true,
              children: modelNodes(conversation.id, conversation.models),
              ...(conversation.id !== UNATTACHED_CONVERSATION_ID
                ? {
                    contextValue: CONVERSATION_CONTEXT,
                    composerId: conversation.id,
                  }
                : {}),
            },
            charged,
          );
        }),
      },
      projectCharged,
    );
  });

  return [
    withCopyText(
      {
        id: 'identity',
        label: snapshot.displayName,
        description: snapshot.email,
        icon: new vscode.ThemeIcon('account'),
        children: teamNodes,
      },
      snapshot.email,
    ),
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
      ...(snapshot.conversations.length === 0
        ? { description: 'Aucune', copyText: 'Aucune', contextValue: COPYABLE_CONTEXT }
        : {}),
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
    let node: FuelNode = {
      id: `conversation-${conversationId}-model-${modelKey}`,
      label,
      icon: new vscode.ThemeIcon('chip'),
    };
    if (!emptyShell) {
      const charged = formatDollars(model.chargedDollars);
      node = withCopyText(
        {
          ...node,
          description: charged,
          tooltip:
            label === model.model
              ? formatTokens(tokenTotal)
              : `${model.model} · ${formatTokens(tokenTotal)}`,
        },
        charged,
      );
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
  const cacheRead = formatTokens(tokens.cacheRead);
  const cacheWrite = formatTokens(tokens.cacheWrite);
  const input = formatTokens(tokens.input);
  const output = formatTokens(tokens.output);
  const total = formatTokens(totalTokens(tokens));
  return [
    withCopyText(
      {
        id: `${prefix}-cache-read`,
        label: 'Lecture cache',
        description: cacheRead,
        tooltip: FIELD_HELP.tokenCacheRead,
        icon: new vscode.ThemeIcon('archive'),
      },
      cacheRead,
    ),
    withCopyText(
      {
        id: `${prefix}-cache-write`,
        label: 'Écriture cache',
        description: cacheWrite,
        tooltip: FIELD_HELP.tokenCacheWrite,
        icon: new vscode.ThemeIcon('save'),
      },
      cacheWrite,
    ),
    withCopyText(
      {
        id: `${prefix}-input`,
        label: 'Entrée',
        description: input,
        tooltip: FIELD_HELP.tokenInput,
        icon: new vscode.ThemeIcon('arrow-down'),
      },
      input,
    ),
    withCopyText(
      {
        id: `${prefix}-output`,
        label: 'Sortie',
        description: output,
        tooltip: FIELD_HELP.tokenOutput,
        icon: new vscode.ThemeIcon('arrow-up'),
      },
      output,
    ),
    withCopyText(
      {
        id: `${prefix}-total`,
        label: 'Total',
        description: total,
        tooltip: FIELD_HELP.tokenTotal,
        icon: new vscode.ThemeIcon('symbol-number'),
      },
      total,
    ),
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
