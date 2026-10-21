import * as vscode from 'vscode';
import { SyncResult } from './sync';

const STATUS_LABELS: Record<SyncResult['status'], string> = {
  applied: 'Angewendet',
  upToDate: 'Aktuell',
  partial: 'Teilweise angewendet',
  failed: 'Fehler',
  notConfigured: 'Keine Config-URL gesetzt',
};

export class SyncStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem('teamSync.status', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Team Sync';
    this.item.command = command;
    this.item.text = '$(sync) Team Sync';
    this.item.tooltip = 'Team Sync: Klicken zum Synchronisieren';
    this.item.show();
  }

  showSyncing(): void {
    this.item.text = '$(sync~spin) Team Sync';
    this.item.tooltip = 'Team Sync: Synchronisiere ...';
    this.item.backgroundColor = undefined;
  }

  showResult(result: SyncResult, finishedAt: Date): void {
    const versionLabel = result.appliedVersion !== undefined ? `Team v${result.appliedVersion}` : 'Team Sync';
    switch (result.status) {
      case 'applied':
      case 'upToDate':
        this.item.text = `$(check) ${versionLabel}`;
        this.item.backgroundColor = undefined;
        break;
      case 'partial':
        this.item.text = `$(warning) ${versionLabel}`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'failed':
        this.item.text = `$(error) ${versionLabel}`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case 'notConfigured':
        this.item.text = '$(circle-slash) Team Sync';
        this.item.backgroundColor = undefined;
        break;
    }

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown('**Team Sync**\n\n');
    tooltip.appendMarkdown(`Status: ${STATUS_LABELS[result.status]}\n\n`);
    if (result.version !== undefined) {
      tooltip.appendMarkdown(`Config-Version: ${result.version}\n\n`);
    }
    tooltip.appendMarkdown(`Angewendete Version: ${result.appliedVersion ?? 'keine'}\n\n`);
    tooltip.appendMarkdown(`Letzter Sync: ${finishedAt.toLocaleString()}\n\n`);
    if (result.errors.length > 0) {
      tooltip.appendMarkdown(`Fehler: ${result.errors.length} (Details im Output "Team Sync")\n\n`);
    }
    tooltip.appendMarkdown('Klicken zum Synchronisieren');
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    this.item.dispose();
  }
}
