import { TeamConfig, validateTeamConfig } from './config';
import { isDeepEqual, isPlainObject, parseJsonc } from './util/json';

export interface BuildInput {
  /** Content of settings.json (JSONC, same format as the VS Code user settings). */
  settingsText?: string;
  /**
   * Content of extensions.json (JSONC). Either the VS Code format `{ "recommendations": [] }`
   * or `{ "install": [] }`. Extensions are only ever added, never uninstalled.
   */
  extensionsText?: string;
  /** Content of the previously generated team-config.json, used to continue the version. */
  previousText?: string;
  /** Explicit version, overrides the automatic increment. */
  version?: number;
}

export interface BuildResult {
  config: TeamConfig;
  /** False if settings and extensions equal the previous file (version kept). */
  changed: boolean;
  warnings: string[];
}

/** Builds team-config.json from settings.json and extensions.json; bumps the version only on changes. */
export function buildTeamConfig(input: BuildInput): BuildResult {
  const settings = input.settingsText !== undefined ? parseSection(input.settingsText, 'settings.json') : {};
  const extensions = input.extensionsText !== undefined ? parseExtensions(input.extensionsText) : { warnings: [] };
  let previous: PreviousConfig | undefined;
  if (input.previousText !== undefined) {
    try {
      previous = parsePrevious(input.previousText);
    } catch (error) {
      // With an explicit version the old file is only needed for change detection.
      if (input.version === undefined) {
        throw error;
      }
    }
  }

  const draft: { version: number; extensions: { install: unknown }; settings: unknown } = {
    version: 0,
    extensions: { install: extensions.install ?? [] },
    settings,
  };
  const changed =
    previous === undefined ||
    !isDeepEqual(previous.extensions, draft.extensions) ||
    !isDeepEqual(previous.settings, draft.settings);
  if (input.version !== undefined) {
    draft.version = input.version;
  } else {
    draft.version = previous === undefined ? 1 : changed ? previous.version + 1 : previous.version;
  }

  const result = validateTeamConfig(draft);
  if (!result.ok) {
    throw new Error(`Ungültige Team-Konfiguration:\n  - ${result.errors.join('\n  - ')}`);
  }
  return { config: result.config, changed, warnings: [...extensions.warnings, ...result.warnings] };
}

export function serializeTeamConfig(config: TeamConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function parseSection(text: string, fileName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    throw new Error(`${fileName}: ungültiges JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${fileName}: muss ein JSON-Objekt sein.`);
  }
  return parsed;
}

function parseExtensions(text: string): { install?: unknown; warnings: string[] } {
  const parsed = parseSection(text, 'extensions.json');
  const warnings = ['uninstall', 'unwantedRecommendations']
    .filter((key) => parsed[key] !== undefined)
    .map((key) => `extensions.json: "${key}" wird ignoriert, Team Sync deinstalliert keine Extensions.`);
  return { install: parsed.install ?? parsed.recommendations, warnings };
}

interface PreviousConfig {
  version: number;
  extensions?: unknown;
  settings?: unknown;
}

/**
 * Only the version must be readable: resetting it could collide with a version
 * that clients already applied, so an unreadable file is an error.
 */
function parsePrevious(text: string): PreviousConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isPlainObject(parsed) || typeof parsed.version !== 'number' || !Number.isInteger(parsed.version)) {
    throw new Error(
      'Die bestehende team-config.json ist ungültig, Version kann nicht fortgeführt werden. Version mit --version angeben.',
    );
  }
  return { version: parsed.version, extensions: parsed.extensions, settings: parsed.settings };
}
