import * as vscode from 'vscode';
import type { UsageSnapshot } from './usage.js';
import { badgePercentFor, type ViewState } from './view-state.js';

type FuelNode = {
  id: string;
  label: string;
  description?: string;
  icon?: vscode.ThemeIcon;
  children?: FuelNode[];
};

export class FuelTreeDataProvider implements vscode.TreeDataProvider<FuelNode>, vscode.Disposable {
  static readonly viewId = 'fuel.view';

  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    FuelNode | undefined | null
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private state: ViewState = { kind: 'loading' };
  private treeView?: vscode.TreeView<FuelNode>;

  attach(treeView: vscode.TreeView<FuelNode>): void {
    this.treeView = treeView;
    this.syncTreeView();
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  setState(state: ViewState): void {
    this.state = state;
    this.onDidChangeTreeDataEmitter.fire(undefined);
    this.syncTreeView();
  }

  getState(): ViewState {
    return this.state;
  }

  getTreeItem(node: FuelNode): vscode.TreeItem {
    const collapsibleState = node.children?.length
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsibleState);
    item.id = node.id;
    if (node.description !== undefined) {
      item.description = node.description;
    }
    if (node.icon) {
      item.iconPath = node.icon;
    }
    return item;
  }

  getChildren(node?: FuelNode): FuelNode[] {
    if (node) {
      return node.children ?? [];
    }
    const snapshot = shownSnapshot(this.state);
    return snapshot ? snapshotNodes(snapshot) : [];
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

function snapshotNodes(snapshot: UsageSnapshot): FuelNode[] {
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
      id: 'group-cycle',
      label: 'Cycle',
      icon: new vscode.ThemeIcon('history'),
      children: cycleNodes,
    },
  ];
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

function formatDollars(value: number): string {
  return DOLLARS_FORMAT.format(value);
}

function formatPercent(value: number): string {
  return PERCENT_FORMAT.format(value / 100);
}

function formatDateTime(value: string): string {
  return DATE_TIME_FORMAT.format(new Date(value));
}
