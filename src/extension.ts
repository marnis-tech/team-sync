import * as vscode from 'vscode';
import { registerMarkdownCommands } from './markdown/commands';
import { SyncStatusBar } from './statusBar';
import { runSync, SyncDeps, SyncResult } from './sync';
import { errorMessage } from './util/json';
import { createLogger, createSyncDeps, TOKEN_SECRET_KEY } from './vscodeAdapters';

const COMMAND_SYNC_NOW = 'teamSync.syncNow';
const COMMAND_SET_TOKEN = 'teamSync.setToken';
const COMMAND_CLEAR_TOKEN = 'teamSync.clearToken';
const COMMAND_SHOW_LOG = 'teamSync.showLog';
const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 1440;
const URL_CHANGE_DEBOUNCE_MS = 1500;

const ACTION_SHOW_LOG = 'Log anzeigen';
const ACTION_OPEN_SETTINGS = 'Einstellungen öffnen';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Team Sync', { log: true });
  const log = createLogger(channel);
  const statusBar = new SyncStatusBar(COMMAND_SYNC_NOW);
  const controller = new SyncController(createSyncDeps(context, log), statusBar, channel);
  const scheduler = new SyncScheduler(controller);
  let urlChangeTimer: NodeJS.Timeout | undefined;

  context.subscriptions.push(
    channel,
    statusBar,
    scheduler,
    { dispose: () => clearTimeout(urlChangeTimer) },
    vscode.commands.registerCommand(COMMAND_SYNC_NOW, () => controller.sync({ force: true, interactive: true })),
    vscode.commands.registerCommand(COMMAND_SET_TOKEN, () => setToken(context, controller, channel)),
    vscode.commands.registerCommand(COMMAND_CLEAR_TOKEN, () => clearToken(context, channel)),
    vscode.commands.registerCommand(COMMAND_SHOW_LOG, () => channel.show()),
    ...registerMarkdownCommands(channel),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('teamSync.syncIntervalMinutes')) {
        scheduler.restart();
      }
      if (event.affectsConfiguration('teamSync.configUrl')) {
        // Debounced, the settings editor fires while typing. A new source may reuse
        // version numbers, so apply it regardless of the stored version.
        clearTimeout(urlChangeTimer);
        urlChangeTimer = setTimeout(() => {
          void controller.sync({ force: true, interactive: false });
        }, URL_CHANGE_DEBOUNCE_MS);
      }
    }),
  );

  scheduler.restart();
  void controller.sync({ force: false, interactive: false, startup: true });
}

export function deactivate(): void {
  // Everything is disposed via context.subscriptions.
}

interface SyncRequest {
  force: boolean;
  /** Triggered by the user: always report the outcome. */
  interactive: boolean;
  startup?: boolean;
}

class SyncController {
  private running: Promise<SyncResult> | undefined;
  private queued: Promise<SyncResult> | undefined;
  private queuedRequest: SyncRequest | undefined;

  constructor(
    private readonly deps: SyncDeps,
    private readonly statusBar: SyncStatusBar,
    private readonly channel: vscode.LogOutputChannel,
  ) {}

  /**
   * Runs one sync at a time. A regular request joins the running sync; a forced one
   * (manual or new URL) is queued once and runs after it, since the running sync may use stale input.
   */
  sync(request: SyncRequest): Promise<SyncResult> {
    if (!this.running) {
      return this.start(request);
    }
    if (!request.force) {
      return this.running;
    }
    this.channel.info('Sync läuft bereits, erneuter Sync folgt im Anschluss.');
    this.queuedRequest = { force: true, interactive: request.interactive || !!this.queuedRequest?.interactive };
    const runQueued = (): Promise<SyncResult> => {
      const next = this.queuedRequest ?? request;
      this.queued = undefined;
      this.queuedRequest = undefined;
      return this.start(next);
    };
    this.queued ??= this.running.then(runQueued, runQueued);
    return this.queued;
  }

  private start(request: SyncRequest): Promise<SyncResult> {
    this.running = this.execute(request).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Never rejects, so callers can fire and forget. */
  private async execute(request: SyncRequest): Promise<SyncResult> {
    try {
      this.statusBar.showSyncing();
      const result = await runSync(this.deps, { force: request.force });
      this.statusBar.showResult(result, new Date());
      void this.notify(result, request).catch((error) => this.channel.error(errorMessage(error)));
      return result;
    } catch (error) {
      // runSync is designed not to throw; this guards against unexpected API failures.
      this.channel.error(`Unerwarteter Fehler: ${errorMessage(error)}`);
      return { status: 'failed', installed: [], settingsChanged: [], settingsReset: [], errors: [errorMessage(error)] };
    }
  }

  private async notify(result: SyncResult, request: SyncRequest): Promise<void> {
    const window = vscode.window;
    switch (result.status) {
      case 'applied': {
        const changed = result.installed.length + result.settingsChanged.length + result.settingsReset.length;
        if (!request.interactive && changed === 0) {
          return;
        }
        await window.showInformationMessage(`Team-Konfiguration Version ${result.version} angewendet.`);
        return;
      }
      case 'upToDate':
        if (request.interactive) {
          await window.showInformationMessage(`Team-Konfiguration ist aktuell (Version ${result.version}).`);
        }
        return;
      case 'partial':
      case 'failed': {
        if (!request.interactive) {
          return;
        }
        const choice =
          result.status === 'partial'
            ? await window.showWarningMessage(
                `Team-Konfiguration Version ${result.version} nur teilweise angewendet.`,
                ACTION_SHOW_LOG,
              )
            : await window.showErrorMessage(
                `Team Sync fehlgeschlagen: ${result.errors[0] ?? 'unbekannter Fehler'}`,
                ACTION_SHOW_LOG,
              );
        if (choice === ACTION_SHOW_LOG) {
          this.channel.show();
        }
        return;
      }
      case 'notConfigured': {
        if (!request.interactive && !request.startup) {
          return;
        }
        const choice = await window.showWarningMessage(
          'Team Sync: Bitte die URL der Team-Konfiguration in "teamSync.configUrl" eintragen.',
          ACTION_OPEN_SETTINGS,
        );
        if (choice === ACTION_OPEN_SETTINGS) {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'teamSync.configUrl');
        }
        return;
      }
    }
  }
}

class SyncScheduler implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly controller: SyncController) {}

  restart(): void {
    this.dispose();
    const configured = vscode.workspace
      .getConfiguration('teamSync')
      .get<number>('syncIntervalMinutes', DEFAULT_INTERVAL_MINUTES);
    const minutes = Number.isFinite(configured)
      ? Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, configured))
      : DEFAULT_INTERVAL_MINUTES;
    this.timer = setInterval(() => {
      void this.controller.sync({ force: false, interactive: false });
    }, minutes * 60_000);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

async function setToken(
  context: vscode.ExtensionContext,
  controller: SyncController,
  channel: vscode.LogOutputChannel,
): Promise<void> {
  const token = await vscode.window.showInputBox({
    title: 'Team Sync: Token setzen',
    prompt: 'Bearer-Token für den Abruf der Team-Konfiguration (leer lassen zum Entfernen)',
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) {
    return;
  }
  try {
    if (token.trim() === '') {
      await context.secrets.delete(TOKEN_SECRET_KEY);
      channel.info('Token entfernt.');
      return;
    }
    await context.secrets.store(TOKEN_SECRET_KEY, token.trim());
    channel.info('Token gespeichert.');
  } catch (error) {
    channel.error(`Token konnte nicht gespeichert werden: ${errorMessage(error)}`);
    void vscode.window.showErrorMessage('Team Sync: Token konnte nicht gespeichert werden.');
    return;
  }
  await controller.sync({ force: false, interactive: true });
}

async function clearToken(context: vscode.ExtensionContext, channel: vscode.LogOutputChannel): Promise<void> {
  try {
    await context.secrets.delete(TOKEN_SECRET_KEY);
    channel.info('Token entfernt.');
    void vscode.window.showInformationMessage('Team Sync: Token entfernt.');
  } catch (error) {
    channel.error(`Token konnte nicht entfernt werden: ${errorMessage(error)}`);
  }
}
