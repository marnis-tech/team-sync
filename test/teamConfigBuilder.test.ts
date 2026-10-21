import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTeamConfig, serializeTeamConfig } from '../src/teamConfigBuilder';
import { parseJsonc } from '../src/util/json';

const SETTINGS = `{
  // Format on save for everybody
  "editor.formatOnSave": true,
  "files.exclude": { "**/node_modules": true, },
  /* URLs with // inside strings stay intact */
  "http.proxy": "http://proxy:3128",
}`;

const EXTENSIONS_VSCODE_FORMAT = `{
  "recommendations": ["esbenp.prettier-vscode", "dbaeumer.vscode-eslint"],
  "unwantedRecommendations": ["hookyqr.beautify"]
}`;

describe('parseJsonc', () => {
  it('removes comments and trailing commas outside strings', () => {
    assert.deepEqual(parseJsonc(SETTINGS), {
      'editor.formatOnSave': true,
      'files.exclude': { '**/node_modules': true },
      'http.proxy': 'http://proxy:3128',
    });
  });

  it('keeps escaped quotes and commas in strings', () => {
    assert.deepEqual(parseJsonc('{ "a": "x\\",}" , "b": [1,2,], }'), { a: 'x",}', b: [1, 2] });
  });

  it('throws on unterminated comments', () => {
    assert.throws(() => parseJsonc('{ /* open '), SyntaxError);
  });
});

describe('buildTeamConfig', () => {
  it('starts with version 1 and maps the VS Code extensions.json format', () => {
    const { config, changed, warnings } = buildTeamConfig({
      settingsText: SETTINGS,
      extensionsText: EXTENSIONS_VSCODE_FORMAT,
    });
    assert.equal(changed, true);
    assert.equal(config.version, 1);
    assert.deepEqual(config.extensions, { install: ['esbenp.prettier-vscode', 'dbaeumer.vscode-eslint'] });
    assert.equal(config.settings['editor.formatOnSave'], true);
    assert.match(warnings.join(), /unwantedRecommendations.*ignoriert/);
  });

  it('accepts the install format', () => {
    const { config, warnings } = buildTeamConfig({ extensionsText: '{ "install": ["a.b"] }' });
    assert.deepEqual(config.extensions, { install: ['a.b'] });
    assert.deepEqual(config.settings, {});
    assert.deepEqual(warnings, []);
  });

  it('keeps the version when nothing changed', () => {
    const first = buildTeamConfig({ settingsText: SETTINGS, extensionsText: EXTENSIONS_VSCODE_FORMAT });
    const previousText = serializeTeamConfig({ ...first.config, version: 7 });
    const second = buildTeamConfig({ settingsText: SETTINGS, extensionsText: EXTENSIONS_VSCODE_FORMAT, previousText });
    assert.equal(second.changed, false);
    assert.equal(second.config.version, 7);
  });

  it('increments the version on changes', () => {
    const previousText = serializeTeamConfig(buildTeamConfig({ settingsText: SETTINGS }).config);
    const next = buildTeamConfig({ settingsText: '{ "editor.formatOnSave": false }', previousText });
    assert.equal(next.changed, true);
    assert.equal(next.config.version, 2);
  });

  it('uses an explicit version', () => {
    const { config } = buildTeamConfig({ settingsText: SETTINGS, previousText: '{ broken', version: 42 });
    assert.equal(config.version, 42);
  });

  it('refuses to guess the version if the previous file is broken', () => {
    assert.throws(() => buildTeamConfig({ settingsText: SETTINGS, previousText: '{ broken' }), /--version/);
  });

  it('validates the result', () => {
    assert.throws(() => buildTeamConfig({ extensionsText: '{ "recommendations": ["no-id"] }' }), /Extension-ID/);
    assert.throws(() => buildTeamConfig({ settingsText: '[1]' }), /JSON-Objekt/);
  });
});
