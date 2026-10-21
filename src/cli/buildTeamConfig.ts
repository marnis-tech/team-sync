/*
 * Generates team-config.json from settings.json and extensions.json.
 *
 *   npm run team-config                         # team/ -> team/team-config.json
 *   npm run team-config -- --dir path/to/folder [--out file] [--version 7] [--check]
 *
 * --check fails if the generated file is not up to date (for CI).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildTeamConfig, serializeTeamConfig } from '../teamConfigBuilder';

interface CliOptions {
  dir: string;
  out?: string;
  version?: number;
  check: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dir: 'team', check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`${arg} erwartet einen Wert.`);
      }
      return value;
    };
    switch (arg) {
      case '--dir':
        options.dir = next();
        break;
      case '--out':
        options.out = next();
        break;
      case '--version': {
        const version = Number(next());
        if (!Number.isInteger(version) || version < 0) {
          throw new Error('--version muss eine ganze Zahl >= 0 sein.');
        }
        options.version = version;
        break;
      }
      case '--check':
        options.check = true;
        break;
      default:
        throw new Error(`Unbekannte Option: ${arg}`);
    }
  }
  return options;
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const dir = resolve(options.dir);
  const outPath = resolve(options.out ?? join(dir, 'team-config.json'));

  const settingsText = readIfExists(join(dir, 'settings.json'));
  const extensionsText = readIfExists(join(dir, 'extensions.json')) ?? readIfExists(join(dir, 'extension.json'));
  if (settingsText === undefined && extensionsText === undefined) {
    throw new Error(`Weder settings.json noch extensions.json in ${dir} gefunden.`);
  }
  const previousText = readIfExists(outPath);

  const result = buildTeamConfig({ settingsText, extensionsText, previousText, version: options.version });
  result.warnings.forEach((warning) => console.warn(`Warnung: ${warning}`));
  const output = serializeTeamConfig(result.config);

  if (options.check) {
    if (output !== previousText) {
      throw new Error(`${outPath} ist nicht aktuell. Bitte "npm run team-config" ausführen.`);
    }
    console.log(`${outPath} ist aktuell (Version ${result.config.version}).`);
    return;
  }

  if (output === previousText) {
    console.log(`Keine Änderungen, Version ${result.config.version} bleibt.`);
    return;
  }
  writeFileSync(outPath, output, 'utf8');
  console.log(`${outPath} geschrieben (Version ${result.config.version}).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
