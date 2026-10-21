import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateTeamConfig } from '../src/config';

describe('validateTeamConfig', () => {
  it('accepts a complete config', () => {
    const result = validateTeamConfig({
      version: 3,
      extensions: { install: ['esbenp.prettier-vscode'] },
      settings: { 'editor.formatOnSave': true, '[typescript]': { 'editor.tabSize': 2 } },
    });
    assert.ok(result.ok);
    assert.equal(result.config.version, 3);
    assert.deepEqual(result.config.extensions.install, ['esbenp.prettier-vscode']);
    assert.deepEqual(result.config.settings['[typescript]'], { 'editor.tabSize': 2 });
    assert.deepEqual(result.warnings, []);
  });

  it('defaults missing extensions and settings to empty', () => {
    const result = validateTeamConfig({ version: 0 });
    assert.ok(result.ok);
    assert.deepEqual(result.config, { version: 0, extensions: { install: [] }, settings: {} });
  });

  for (const [label, input] of [
    ['null', null],
    ['an array', []],
    ['a string', 'config'],
  ] as const) {
    it(`rejects ${label} as root`, () => {
      assert.equal(validateTeamConfig(input).ok, false);
    });
  }

  for (const version of [undefined, '1', 1.5, -1, Number.NaN]) {
    it(`rejects version ${String(version)}`, () => {
      const result = validateTeamConfig({ version });
      assert.ok(!result.ok);
      assert.match(result.errors.join(), /version/);
    });
  }

  it('rejects wrong types in extensions and settings', () => {
    assert.equal(validateTeamConfig({ version: 1, extensions: [] }).ok, false);
    const result = validateTeamConfig({ version: 1, extensions: { install: 'a.b' }, settings: [] });
    assert.ok(!result.ok);
    assert.equal(result.errors.length, 2);
  });

  it('rejects invalid extension ids', () => {
    const result = validateTeamConfig({ version: 1, extensions: { install: ['no-dot', 'a.b', ' x.y', 'a.b.c', 1] } });
    assert.ok(!result.ok);
    assert.equal(result.errors.length, 4);
  });

  it('ignores extensions.uninstall with a warning (Team Sync never uninstalls)', () => {
    const result = validateTeamConfig({ version: 1, extensions: { install: ['a.b'], uninstall: ['c.d'] } });
    assert.ok(result.ok);
    assert.deepEqual(result.config.extensions, { install: ['a.b'] });
    assert.match(result.warnings.join(), /deinstalliert keine/);
  });

  it('refuses settings that control the sync itself', () => {
    for (const key of ['teamSync.configUrl', 'teamSync.syncIntervalMinutes']) {
      assert.equal(validateTeamConfig({ version: 1, settings: { [key]: 'x' } }).ok, false);
    }
  });

  it('accepts the Markdown settings of the extension', () => {
    assert.ok(validateTeamConfig({ version: 1, settings: { 'teamSync.markdown.tableClass': 'table' } }).ok);
  });

  it('warns about unknown keys and duplicates but stays valid', () => {
    const result = validateTeamConfig({
      $schema: './schema.json',
      version: 1,
      owner: 'team',
      extensions: { install: ['a.b', 'A.B'], disable: [] },
    });
    assert.ok(result.ok);
    assert.deepEqual(result.config.extensions.install, ['a.b']);
    assert.equal(result.warnings.length, 3);
  });

  it('rejects a __proto__ settings key', () => {
    assert.equal(validateTeamConfig(JSON.parse('{ "version": 1, "settings": { "__proto__": { "a": 1 } } }')).ok, false);
  });

  it('keeps null setting values (meaning: remove)', () => {
    const result = validateTeamConfig({ version: 1, settings: { 'editor.rulers': null } });
    assert.ok(result.ok);
    assert.equal(result.config.settings['editor.rulers'], null);
  });
});
