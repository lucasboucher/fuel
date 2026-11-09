import * as vscode from 'vscode';
import { badgePercentFor, type ViewState } from './state.js';
import type { SpendSnapshot } from './usage.js';

export type { ViewState };

type FuelItem = {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: vscode.ThemeIcon;
  command?: vscode.Command;
  children?: FuelItem[];
};

export class FuelViewProvider implements vscode.TreeDataProvider<FuelItem>, vscode.Disposable {
  static readonly viewType = 'fuel.view';

  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    FuelItem | undefined | null
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private state: ViewState = { kind: 'loading' };
  private treeView?: vscode.TreeView<FuelItem>;
  attach(treeView: vscode.TreeView<FuelItem>): void {
    this.treeView = treeView;
    this.syncChrome();
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  setState(state: ViewState): void {
    this.state = state;
    this.onDidChangeTreeDataEmitter.fire(undefined);
    this.syncChrome();
  }

  getState(): ViewState {
    return this.state;
  }

  getTreeItem(element: FuelItem): vscode.TreeItem {
    const collapsible = element.children?.length
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsible);
    item.id = element.id;
    if (element.description !== undefined) {
      item.description = element.description;
    }
    if (element.tooltip !== undefined) {
      item.tooltip = element.tooltip;
    }
    if (element.icon) {
      item.iconPath = element.icon;
    }
    if (element.command) {
      item.command = element.command;
    }
    return item;
  }

  getChildren(element?: FuelItem): FuelItem[] {
    if (element) {
      return element.children ?? [];
    }

    if (this.state.kind === 'loading') {
      return [
        {
          id: 'loading',
          label: this.state.email ? `Chargement · ${this.state.email}…` : 'Chargement…',
          icon: new vscode.ThemeIcon('loading~spin'),
        },
      ];
    }

    if (this.state.kind === 'needs_key') {
      return [
        {
          id: 'needs-key',
          label: 'Clé d’API manquante',
          description: 'Définir la clé',
          icon: new vscode.ThemeIcon('key'),
          command: {
            command: 'fuel.setApiKey',
            title: 'Définir la clé d’API',
          },
        },
        {
          id: 'dashboard',
          label: 'Ouvrir le tableau de bord',
          icon: new vscode.ThemeIcon('link-external'),
          command: {
            command: 'vscode.open',
            title: 'Ouvrir le tableau de bord',
            arguments: [vscode.Uri.parse('https://cursor.com/dashboard/spending')],
          },
        },
      ];
    }

    if (this.state.kind === 'error') {
      const items: FuelItem[] = [];
      if (this.state.code === 'unauthorized') {
        items.push({
          id: 'set-key',
          label: 'Définir la clé',
          icon: new vscode.ThemeIcon('key'),
          command: { command: 'fuel.setApiKey', title: 'Définir la clé d’API' },
        });
      }
      items.push({
        id: 'retry',
        label: 'Réessayer',
        icon: new vscode.ThemeIcon('refresh'),
        command: { command: 'fuel.refresh', title: 'Rafraîchir' },
      });
      if (this.state.snapshot) {
        items.push(...snapshotRoots(this.state.snapshot, true));
      }
      return items;
    }

    return snapshotRoots(this.state.snapshot, false);
  }

  private syncChrome(): void {
    if (!this.treeView) {
      return;
    }

    const badgePercent = badgePercentFor(this.state);
    if (badgePercent !== undefined) {
      const value = Math.round(badgePercent);
      this.treeView.badge = {
        value,
        tooltip: `${value} % d’usage inclus`,
      };
    } else {
      this.treeView.badge = undefined;
    }

    if (this.state.kind === 'ready' || this.state.kind === 'loading') {
      this.treeView.message = '';
      return;
    }
    if (this.state.kind === 'needs_key') {
      this.treeView.message = 'Ajoute une clé d’API d’équipe pour afficher ta dépense du cycle.';
      return;
    }
    this.treeView.message = this.state.message;
  }
}

function snapshotRoots(snapshot: SpendSnapshot, nested: boolean): FuelItem[] {
  const identity: FuelItem = {
    id: nested ? 'cached-title' : 'identity',
    label: nested ? 'Dernière valeur connue' : snapshot.name || snapshot.email,
    icon: new vscode.ThemeIcon('account'),
  };
  if (nested || snapshot.name) {
    identity.description = snapshot.email;
  }

  const usageChildren: FuelItem[] = [];
  if (snapshot.totalPercentUsed !== undefined) {
    usageChildren.push({
      id: 'total-usage',
      label: 'Total inclus',
      description: formatPercent(snapshot.totalPercentUsed),
      icon: new vscode.ThemeIcon('dashboard'),
    });
  }
  if (snapshot.cursorModelsPercent !== undefined) {
    usageChildren.push({
      id: 'cursor-models',
      label: 'Modèles Cursor',
      description: formatPercent(snapshot.cursorModelsPercent),
      icon: new vscode.ThemeIcon('rocket'),
    });
  }
  if (snapshot.otherModelsPercent !== undefined) {
    usageChildren.push({
      id: 'other-models',
      label: 'Autres modèles',
      description: formatPercent(snapshot.otherModelsPercent),
      icon: new vscode.ThemeIcon('symbol-misc'),
    });
  }

  const spendChildren: FuelItem[] = [
    {
      id: 'included',
      label: 'Dépense incluse',
      description: formatDollars(snapshot.includedSpendDollars),
      icon: new vscode.ThemeIcon('credit-card'),
    },
    {
      id: 'ondemand',
      label: 'À la demande',
      description: formatDollars(snapshot.onDemandSpendDollars),
      icon: new vscode.ThemeIcon('flame'),
    },
  ];

  if (snapshot.limitDollars !== undefined) {
    spendChildren.push(
      {
        id: 'limit',
        label: 'Limite',
        description: formatDollars(snapshot.limitDollars),
        icon: new vscode.ThemeIcon('target'),
      },
      {
        id: 'used',
        label: 'Utilisé (limite $)',
        description: formatPercent(snapshot.percentUsed),
        icon: new vscode.ThemeIcon('pie-chart'),
      },
    );
  } else if (usageChildren.length === 0) {
    spendChildren.push({
      id: 'nolimit',
      label: 'Aucune limite individuelle renseignée',
      icon: new vscode.ThemeIcon('info'),
    });
  }

  const roots: FuelItem[] = [identity];

  if (usageChildren.length > 0) {
    roots.push({
      id: 'group-usage',
      label: 'Usage',
      children: usageChildren,
    });
  }

  roots.push({
    id: 'group-spend',
    label: 'Dépenses',
    children: spendChildren,
  });

  roots.push({
    id: 'group-cycle',
    label: 'Cycle',
    children: [
      {
        id: 'cycle',
        label: 'Début du cycle',
        description: formatDate(snapshot.cycleStart),
        icon: new vscode.ThemeIcon('calendar'),
      },
      {
        id: 'fetched',
        label: 'Mis à jour',
        description: formatDate(snapshot.fetchedAt),
        icon: new vscode.ThemeIcon('clock'),
      },
    ],
  });

  roots.push({
    id: 'dashboard',
    label: 'Tableau de bord',
    icon: new vscode.ThemeIcon('link-external'),
    command: {
      command: 'vscode.open',
      title: 'Tableau de bord',
      arguments: [vscode.Uri.parse('https://cursor.com/dashboard/spending')],
    },
  });

  return roots;
}

function formatDollars(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) {
    return '—';
  }
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(value)} %`;
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return '—';
  }
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}
