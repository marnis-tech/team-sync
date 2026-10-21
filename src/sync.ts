import { LoadedConfig } from './loadConfig';
import { errorMessage, isDeepEqual, isPlainObject } from './util/json';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Only adds extensions; Team Sync never uninstalls anything. */
export interface ExtensionManager {
  isInstalled(id: string): boolean;
  install(id: string): Promise<void>;
}

export interface SettingsStore {
  /** Current value in the user settings, `undefined` if not set there. */
  getGlobalValue(key: string): unknown;
  /** Writes to the user settings; `undefined` removes the entry. */
  setGlobalValue(key: string, value: unknown): Promise<void>;
}

/** What was applied last: the version and the settings values the team config set. */
export interface AppliedState {
  version: number;
  settings: Record<string, unknown>;
}

export interface StateStore {
  getApplied(): AppliedState | undefined;
  setApplied(state: AppliedState): Promise<void>;
}

export interface SyncDeps {
  getConfigUrl(): string;
  loadConfig(url: string): Promise<LoadedConfig>;
  extensions: ExtensionManager;
  settings: SettingsStore;
  state: StateStore;
  log: Logger;
  /** Resolves once newly installed extensions are registered (or after a timeout). */
  waitForExtensionChanges?(): Promise<void>;
}

export type SyncStatus = 'applied' | 'upToDate' | 'partial' | 'failed' | 'notConfigured';

export interface SyncResult {
  status: SyncStatus;
  /** Version of the loaded config, if it could be loaded. */
  version?: number;
  /** Version stored as successfully applied after this run. */
  appliedVersion?: number;
  installed: string[];
  settingsChanged: string[];
  /** Settings reset because the team config no longer contains them. */
  settingsReset: string[];
  errors: string[];
}

export interface SyncOptions {
  /** Apply even if the version did not change. */
  force: boolean;
}

/**
 * Loads the team config and applies it: installs missing extensions, then writes settings
 * (settings last, so settings of freshly installed extensions are registered) and resets
 * settings the team config dropped. The state is only stored when everything succeeded,
 * so failures are retried on the next run. Never throws.
 */
export async function runSync(deps: SyncDeps, options: SyncOptions): Promise<SyncResult> {
  const { log } = deps;
  const previous = safeApplied(deps);
  const result: SyncResult = {
    status: 'failed',
    appliedVersion: previous?.version,
    installed: [],
    settingsChanged: [],
    settingsReset: [],
    errors: [],
  };

  const url = deps.getConfigUrl().trim();
  if (!url) {
    log.warn('Keine Config-URL gesetzt. Bitte die Einstellung "teamSync.configUrl" konfigurieren.');
    result.status = 'notConfigured';
    return result;
  }

  let loaded: LoadedConfig;
  try {
    loaded = await deps.loadConfig(url);
  } catch (error) {
    const message = errorMessage(error);
    log.error(`Team-Konfiguration konnte nicht geladen werden: ${message}`);
    result.errors.push(message);
    return result;
  }

  const { config } = loaded;
  result.version = config.version;
  loaded.warnings.forEach((warning) => log.warn(warning));

  if (!options.force && previous?.version === config.version) {
    log.info(`Version ${config.version} ist bereits angewendet.`);
    result.status = 'upToDate';
    return result;
  }

  log.info(`Wende Team-Konfiguration Version ${config.version} an${options.force ? ' (erzwungen)' : ''}.`);

  for (const id of config.extensions.install) {
    if (deps.extensions.isInstalled(id)) {
      continue;
    }
    try {
      await deps.extensions.install(id);
      result.installed.push(id);
      log.info(`Extension installiert: ${id}`);
    } catch (error) {
      result.errors.push(`Installation von ${id} fehlgeschlagen: ${errorMessage(error)}`);
    }
  }

  const previousSettings = previous?.settings ?? {};
  const entries: SettingEntry[] = Object.entries(config.settings).map(([key, value]) => ({
    key,
    resolve: (current) => resolveSettingValue(key, value, current, previousSettings[key]),
  }));
  let failedSettings = await applySettings(deps, entries, result.settingsChanged);
  if (failedSettings.length > 0 && result.installed.length > 0 && deps.waitForExtensionChanges) {
    // Settings of just installed extensions may not be registered yet; retry once.
    log.info('Warte auf Registrierung neu installierter Extensions und versuche Einstellungen erneut.');
    await deps.waitForExtensionChanges();
    failedSettings = await applySettings(deps, failedSettings.map(({ entry }) => entry), result.settingsChanged);
  }
  for (const { entry, error } of failedSettings) {
    result.errors.push(`Einstellung "${entry.key}" konnte nicht geschrieben werden: ${errorMessage(error)}`);
  }

  const removed: SettingEntry[] = Object.keys(previousSettings)
    .filter((key) => !Object.hasOwn(config.settings, key))
    .map((key) => ({ key, resolve: (current) => resolveRemovedSetting(key, previousSettings[key], current) }));
  for (const { entry, error } of await applySettings(deps, removed, result.settingsReset)) {
    // Usually the owning extension is gone; a leftover value does no harm, so this is no error.
    log.warn(`Einstellung "${entry.key}" konnte nicht zurückgesetzt werden: ${errorMessage(error)}`);
  }

  result.errors.forEach((message) => log.error(message));

  if (result.errors.length > 0) {
    log.warn(`Version ${config.version} nur teilweise angewendet, nächster Sync versucht es erneut.`);
    result.status = 'partial';
    return result;
  }

  try {
    await deps.state.setApplied({ version: config.version, settings: managedSettings(config.settings) });
    result.appliedVersion = config.version;
  } catch (error) {
    log.warn(`Angewendete Version konnte nicht gespeichert werden: ${errorMessage(error)}`);
  }
  log.info(
    `Version ${config.version} angewendet: ${result.installed.length} Extensions installiert, ` +
      `${result.settingsChanged.length} Einstellungen geändert, ${result.settingsReset.length} zurückgesetzt.`,
  );
  result.status = 'applied';
  return result;
}

const LANGUAGE_OVERRIDE_KEY = /^\[.+\]$/;

function isLanguageOverride(key: string): boolean {
  return LANGUAGE_OVERRIDE_KEY.test(key);
}

/**
 * Value to write for a team setting. `null` removes the user setting. Language overrides
 * like "[markdown]" are merged into the user's existing override so personal entries survive;
 * entries the team set before and dropped now are removed if the user did not change them.
 */
export function resolveSettingValue(
  key: string,
  teamValue: unknown,
  current: unknown,
  previousTeamValue?: unknown,
): unknown {
  if (teamValue === null) {
    return undefined;
  }
  if (!isLanguageOverride(key) || !isPlainObject(teamValue)) {
    return teamValue;
  }
  const merged: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  if (isPlainObject(previousTeamValue)) {
    for (const [innerKey, innerValue] of Object.entries(previousTeamValue)) {
      if (!Object.hasOwn(teamValue, innerKey) && isDeepEqual(merged[innerKey], innerValue)) {
        delete merged[innerKey];
      }
    }
  }
  for (const [innerKey, innerValue] of Object.entries(teamValue)) {
    if (innerValue === null) {
      delete merged[innerKey];
    } else {
      merged[innerKey] = innerValue;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Value for a setting the team config no longer contains: removed if it still has the
 * value the team set, kept if the user changed it in the meantime.
 */
export function resolveRemovedSetting(key: string, previousTeamValue: unknown, current: unknown): unknown {
  if (isLanguageOverride(key) && isPlainObject(previousTeamValue) && isPlainObject(current)) {
    const remaining = { ...current };
    for (const [innerKey, innerValue] of Object.entries(previousTeamValue)) {
      if (isDeepEqual(remaining[innerKey], innerValue)) {
        delete remaining[innerKey];
      }
    }
    return Object.keys(remaining).length > 0 ? remaining : undefined;
  }
  return isDeepEqual(current, previousTeamValue) ? undefined : current;
}

/** Settings values the team config sets (removals via `null` are not tracked). */
function managedSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const managed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === null) {
      continue;
    }
    if (isLanguageOverride(key) && isPlainObject(value)) {
      managed[key] = Object.fromEntries(Object.entries(value).filter(([, inner]) => inner !== null));
    } else {
      managed[key] = value;
    }
  }
  return managed;
}

interface SettingEntry {
  key: string;
  resolve(current: unknown): unknown;
}

async function applySettings(
  deps: SyncDeps,
  entries: SettingEntry[],
  changed: string[],
): Promise<Array<{ entry: SettingEntry; error: unknown }>> {
  const failed: Array<{ entry: SettingEntry; error: unknown }> = [];
  for (const entry of entries) {
    try {
      const current = deps.settings.getGlobalValue(entry.key);
      const value = entry.resolve(current);
      if (isDeepEqual(current, value)) {
        continue;
      }
      await deps.settings.setGlobalValue(entry.key, value);
      changed.push(entry.key);
      deps.log.info(value === undefined ? `Einstellung entfernt: ${entry.key}` : `Einstellung gesetzt: ${entry.key}`);
    } catch (error) {
      failed.push({ entry, error });
    }
  }
  return failed;
}

function safeApplied(deps: SyncDeps): AppliedState | undefined {
  try {
    const applied = deps.state.getApplied();
    if (applied && typeof applied.version === 'number' && isPlainObject(applied.settings)) {
      return applied;
    }
  } catch {
    // Treated like a first run.
  }
  return undefined;
}
