import { isPlainObject } from './util/json';

/** Settings that control the sync itself; the team config must not redirect or throttle it. */
export const RESERVED_SETTINGS = new Set(['teamSync.configUrl', 'teamSync.syncIntervalMinutes']);

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9_-]*$/i;
const KNOWN_TOP_LEVEL_KEYS = new Set(['$schema', 'version', 'extensions', 'settings']);
const KNOWN_EXTENSION_KEYS = new Set(['install']);

export interface TeamConfig {
  version: number;
  extensions: {
    /** Installed when missing. Team Sync never uninstalls extensions. */
    install: string[];
  };
  /** Values are written to the user settings; `null` removes the user setting. */
  settings: Record<string, unknown>;
}

export type ValidationResult =
  | { ok: true; config: TeamConfig; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** Validates untrusted JSON (already parsed) against the team-config.json format. */
export function validateTeamConfig(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['Die Konfiguration muss ein JSON-Objekt sein.'], warnings };
  }

  for (const key of Object.keys(input)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`Unbekannter Eintrag "${key}" wird ignoriert.`);
    }
  }

  const version = input.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    errors.push('"version" muss eine ganze Zahl >= 0 sein.');
  }

  const install: string[] = [];
  if (input.extensions !== undefined) {
    if (!isPlainObject(input.extensions)) {
      errors.push('"extensions" muss ein Objekt sein.');
    } else {
      for (const key of Object.keys(input.extensions)) {
        if (key === 'uninstall') {
          warnings.push('"extensions.uninstall" wird ignoriert: Team Sync deinstalliert keine Extensions.');
        } else if (!KNOWN_EXTENSION_KEYS.has(key)) {
          warnings.push(`Unbekannter Eintrag "extensions.${key}" wird ignoriert.`);
        }
      }
      install.push(...validateIdList(input.extensions.install, 'extensions.install', errors, warnings));
    }
  }

  const settings: Record<string, unknown> = {};
  if (input.settings !== undefined) {
    if (!isPlainObject(input.settings)) {
      errors.push('"settings" muss ein Objekt sein.');
    } else {
      for (const [key, value] of Object.entries(input.settings)) {
        if (key.trim() === '' || key !== key.trim() || key === '__proto__') {
          errors.push(`Ungültiger Settings-Schlüssel "${key}".`);
        } else if (RESERVED_SETTINGS.has(key)) {
          errors.push(`"${key}": steuert den Sync selbst und kann nicht zentral gesetzt werden.`);
        } else {
          settings[key] = value;
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }
  return {
    ok: true,
    config: { version: version as number, extensions: { install }, settings },
    warnings,
  };
}

function validateIdList(value: unknown, path: string, errors: string[], warnings: string[]): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`"${path}" muss ein Array von Extension-IDs sein.`);
    return [];
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !EXTENSION_ID_PATTERN.test(item)) {
      errors.push(`${path}[${index}]: ${JSON.stringify(item)} ist keine gültige Extension-ID (Format "publisher.name").`);
      return;
    }
    const lower = item.toLowerCase();
    if (seen.has(lower)) {
      warnings.push(`${path}: "${item}" ist doppelt eingetragen.`);
      return;
    }
    seen.add(lower);
    ids.push(item);
  });
  return ids;
}
