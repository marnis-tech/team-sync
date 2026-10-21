import * as vscode from 'vscode';
import { loadTeamConfig } from './loadConfig';
import { AppliedState, Logger, SyncDeps } from './sync';
import { errorMessage } from './util/json';

export const TOKEN_SECRET_KEY = 'teamSync.token';
const APPLIED_STATE_KEY = 'teamSync.appliedState';
const EXTENSION_REGISTRATION_TIMEOUT_MS = 5_000;

export function createLogger(channel: vscode.LogOutputChannel): Logger {
  return {
    info: (message) => channel.info(message),
    warn: (message) => channel.warn(message),
    error: (message) => channel.error(message),
  };
}

export function getConfigUrl(): string {
  return vscode.workspace.getConfiguration('teamSync').get<string>('configUrl', '') ?? '';
}

export function createSyncDeps(context: vscode.ExtensionContext, log: Logger): SyncDeps {
  return {
    getConfigUrl,

    async loadConfig(url) {
      let token: string | undefined;
      try {
        token = await context.secrets.get(TOKEN_SECRET_KEY);
      } catch (error) {
        log.warn(`Token konnte nicht gelesen werden, lade ohne Token: ${errorMessage(error)}`);
      }
      return loadTeamConfig(url, { token });
    },

    extensions: {
      isInstalled: (id) => vscode.extensions.getExtension(id) !== undefined,
      install: async (id) => {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
      },
    },

    settings: {
      getGlobalValue: (key) => vscode.workspace.getConfiguration().inspect(key)?.globalValue,
      setGlobalValue: async (key, value) => {
        await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
      },
    },

    state: {
      getApplied: () => context.globalState.get<AppliedState>(APPLIED_STATE_KEY),
      setApplied: async (state) => {
        await context.globalState.update(APPLIED_STATE_KEY, state);
      },
    },

    log,

    waitForExtensionChanges: () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, EXTENSION_REGISTRATION_TIMEOUT_MS);
        const listener = vscode.extensions.onDidChange(done);
        function done(): void {
          clearTimeout(timer);
          listener.dispose();
          resolve();
        }
      }),
  };
}
