/*
 * Runs the integration suite in a real VS Code (the oldest supported version by default).
 *   npm run test:integration
 *   VSCODE_VERSION=stable npm run test:integration
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = resolve(__dirname, '../..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'team-sync-it-'));
  try {
    await runTests({
      version: process.env.VSCODE_VERSION ?? '1.90.0',
      extensionDevelopmentPath: root,
      extensionTestsPath: resolve(__dirname, 'suite'),
      launchArgs: ['--disable-extensions', '--user-data-dir', userDataDir, '--skip-welcome', '--skip-release-notes'],
    });
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
