import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TeamConfig } from '../src/config';
import { AppliedState, resolveRemovedSetting, resolveSettingValue, runSync, SyncDeps } from '../src/sync';

interface FakeOptions {
  url?: string;
  config?: TeamConfig;
  loadError?: Error;
  installed?: string[];
  settings?: Record<string, unknown>;
  applied?: AppliedState;
  failInstall?: string[];
  /** Keys that fail until waitForExtensionChanges was called. */
  unregisteredSettings?: string[];
  /** Keys that always fail. */
  failingSettings?: string[];
}

function config(partial: Partial<TeamConfig> & { version: number }): TeamConfig {
  return { extensions: { install: [] }, settings: {}, ...partial };
}

function createFake(options: FakeOptions) {
  const installed = new Set((options.installed ?? []).map((id) => id.toLowerCase()));
  const settings = new Map(Object.entries(options.settings ?? {}));
  const calls = { install: [] as string[], writes: [] as string[], waited: 0 };
  const logs: string[] = [];
  let applied = options.applied;
  let registered = false;

  const deps: SyncDeps = {
    getConfigUrl: () => options.url ?? 'https://example.com/team-config.json',
    loadConfig: async () => {
      if (options.loadError) {
        throw options.loadError;
      }
      return { config: options.config ?? config({ version: 1 }), warnings: [] };
    },
    extensions: {
      isInstalled: (id) => installed.has(id.toLowerCase()),
      install: async (id) => {
        calls.install.push(id);
        if (options.failInstall?.includes(id)) {
          throw new Error('marketplace unavailable');
        }
        installed.add(id.toLowerCase());
      },
    },
    settings: {
      getGlobalValue: (key) => settings.get(key),
      setGlobalValue: async (key, value) => {
        if (options.failingSettings?.includes(key) || (!registered && options.unregisteredSettings?.includes(key))) {
          throw new Error(`${key} is not a registered configuration`);
        }
        calls.writes.push(key);
        if (value === undefined) {
          settings.delete(key);
        } else {
          settings.set(key, value);
        }
      },
    },
    state: {
      getApplied: () => applied,
      setApplied: async (state) => {
        applied = state;
      },
    },
    log: {
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`),
      error: (message) => logs.push(`error: ${message}`),
    },
    waitForExtensionChanges: async () => {
      calls.waited++;
      registered = true;
    },
  };
  return { deps, calls, logs, settings, installed, getApplied: () => applied };
}

describe('resolveSettingValue', () => {
  it('replaces regular values and removes on null', () => {
    assert.deepEqual(resolveSettingValue('files.exclude', { a: true }, { b: true }), { a: true });
    assert.equal(resolveSettingValue('editor.tabSize', null, 4), undefined);
  });

  it('merges language overrides and removes the override when it becomes empty', () => {
    assert.deepEqual(resolveSettingValue('[go]', { a: 1 }, { b: 2 }), { b: 2, a: 1 });
    assert.equal(resolveSettingValue('[go]', { b: null }, { b: 2 }), undefined);
  });

  it('drops override entries the team removed, unless the user changed them', () => {
    const previous = { a: 1, b: 2 };
    assert.deepEqual(resolveSettingValue('[go]', { c: 3 }, { a: 1, b: 5, own: true }, previous), {
      b: 5,
      own: true,
      c: 3,
    });
  });
});

describe('resolveRemovedSetting', () => {
  it('removes values that still have the team value', () => {
    assert.equal(resolveRemovedSetting('editor.tabSize', 2, 2), undefined);
    assert.deepEqual(resolveRemovedSetting('files.exclude', { a: true }, { a: true }), undefined);
  });

  it('keeps values the user changed', () => {
    assert.equal(resolveRemovedSetting('editor.tabSize', 2, 4), 4);
    assert.equal(resolveRemovedSetting('editor.tabSize', 2, undefined), undefined);
  });

  it('removes only the team entries of a language override', () => {
    assert.deepEqual(resolveRemovedSetting('[go]', { a: 1, b: 2 }, { a: 1, b: 3, own: true }), { b: 3, own: true });
    assert.equal(resolveRemovedSetting('[go]', { a: 1 }, { a: 1 }), undefined);
  });
});

describe('runSync', () => {
  it('reports notConfigured without a URL', async () => {
    const fake = createFake({ url: '  ' });
    const result = await runSync(fake.deps, { force: false });
    assert.equal(result.status, 'notConfigured');
    assert.match(fake.logs.join(), /teamSync\.configUrl/);
  });

  it('returns failed and logs when loading fails', async () => {
    const fake = createFake({ loadError: new Error('Netzwerkfehler: ENOTFOUND'), applied: { version: 2, settings: {} } });
    const result = await runSync(fake.deps, { force: false });
    assert.equal(result.status, 'failed');
    assert.equal(result.appliedVersion, 2);
    assert.deepEqual(result.errors, ['Netzwerkfehler: ENOTFOUND']);
    assert.match(fake.logs.join(), /error: .*ENOTFOUND/);
  });

  it('installs missing extensions, keeps all others and writes settings', async () => {
    const fake = createFake({
      installed: ['keep.me', 'private.extension'],
      settings: { 'editor.tabSize': 4, 'editor.rulers': [80] },
      config: config({
        version: 2,
        extensions: { install: ['keep.me', 'new.extension'] },
        settings: { 'editor.tabSize': 2, 'editor.formatOnSave': true, 'editor.rulers': null },
      }),
    });
    const result = await runSync(fake.deps, { force: false });

    assert.equal(result.status, 'applied');
    assert.deepEqual(fake.calls.install, ['new.extension']);
    assert.deepEqual([...fake.installed].sort(), ['keep.me', 'new.extension', 'private.extension']);
    assert.deepEqual(result.settingsChanged, ['editor.tabSize', 'editor.formatOnSave', 'editor.rulers']);
    assert.equal(fake.settings.get('editor.tabSize'), 2);
    assert.equal(fake.settings.has('editor.rulers'), false);
    assert.deepEqual(fake.getApplied(), {
      version: 2,
      settings: { 'editor.tabSize': 2, 'editor.formatOnSave': true },
    });
  });

  it('skips when the version is already applied', async () => {
    const fake = createFake({
      applied: { version: 5, settings: {} },
      config: config({ version: 5, extensions: { install: ['new.extension'] } }),
    });
    const result = await runSync(fake.deps, { force: false });
    assert.equal(result.status, 'upToDate');
    assert.deepEqual(fake.calls.install, []);
  });

  it('applies the same version again when forced', async () => {
    const fake = createFake({
      applied: { version: 5, settings: {} },
      config: config({ version: 5, extensions: { install: ['new.extension'] } }),
    });
    const result = await runSync(fake.deps, { force: true });
    assert.equal(result.status, 'applied');
    assert.deepEqual(fake.calls.install, ['new.extension']);
  });

  it('also applies a lower version (rollback on the server)', async () => {
    const fake = createFake({ applied: { version: 5, settings: {} }, config: config({ version: 4 }) });
    const result = await runSync(fake.deps, { force: false });
    assert.equal(result.status, 'applied');
    assert.equal(fake.getApplied()?.version, 4);
  });

  it('treats a stored state of an older format as a first run', async () => {
    const fake = createFake({ config: config({ version: 1 }) });
    fake.deps.state.getApplied = () => 3 as unknown as AppliedState;
    const result = await runSync(fake.deps, { force: false });
    assert.equal(result.status, 'applied');
  });

  it('does not rewrite settings that already have the value', async () => {
    const fake = createFake({
      settings: { 'files.exclude': { '**/.git': true } },
      config: config({ version: 1, settings: { 'files.exclude': { '**/.git': true } } }),
    });
    const result = await runSync(fake.deps, { force: false });
    assert.equal(result.status, 'applied');
    assert.deepEqual(fake.calls.writes, []);
  });

  it('resets settings the team config dropped, unless the user changed them', async () => {
    const fake = createFake({
      applied: { version: 1, settings: { 'editor.tabSize': 2, 'editor.wordWrap': 'on', 'editor.formatOnSave': true } },
      settings: { 'editor.tabSize': 2, 'editor.wordWrap': 'off', 'editor.formatOnSave': true },
      config: config({ version: 2, settings: { 'editor.formatOnSave': true } }),
    });
    const result = await runSync(fake.deps, { force: false });
    assert.equal(result.status, 'applied');
    assert.deepEqual(result.settingsReset, ['editor.tabSize']);
    assert.equal(fake.settings.has('editor.tabSize'), false);
    assert.equal(fake.settings.get('editor.wordWrap'), 'off');
    assert.deepEqual(fake.getApplied()?.settings, { 'editor.formatOnSave': true });
  });

  it('only warns when a dropped setting cannot be reset', async () => {
    const fake = createFake({
      applied: { version: 1, settings: { 'gone.setting': 1 } },
      settings: { 'gone.setting': 1 },
      failingSettings: ['gone.setting'],
      config: config({ version: 2 }),
    });
    const result = await runSync(fake.deps, { force: false });
    assert.equal(result.status, 'applied');
    assert.match(fake.logs.join(), /warn: .*gone\.setting/);
  });

  it('merges language overrides into the existing user override', async () => {
    const fake = createFake({
      settings: { '[markdown]': { 'editor.wordWrap': 'on', 'editor.rulers': [80] } },
      config: config({
        version: 1,
        settings: { '[markdown]': { 'editor.defaultFormatter': 'x.y', 'editor.rulers': null } },
      }),
    });
    await runSync(fake.deps, { force: false });
    assert.deepEqual(fake.settings.get('[markdown]'), { 'editor.wordWrap': 'on', 'editor.defaultFormatter': 'x.y' });
    assert.deepEqual(fake.getApplied()?.settings, { '[markdown]': { 'editor.defaultFormatter': 'x.y' } });
  });

  it('continues after a failed install, reports partial and keeps the old state', async () => {
    const fake = createFake({
      applied: { version: 1, settings: {} },
      failInstall: ['broken.extension'],
      config: config({
        version: 2,
        extensions: { install: ['broken.extension', 'good.extension'] },
        settings: { 'editor.tabSize': 2 },
      }),
    });
    const result = await runSync(fake.deps, { force: false });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.installed, ['good.extension']);
    assert.equal(fake.settings.get('editor.tabSize'), 2);
    assert.equal(fake.getApplied()?.version, 1);
    assert.equal(result.errors.length, 1);
  });

  it('retries settings of freshly installed extensions once', async () => {
    const fake = createFake({
      unregisteredSettings: ['prettier.singleQuote'],
      config: config({
        version: 1,
        extensions: { install: ['esbenp.prettier-vscode'] },
        settings: { 'prettier.singleQuote': true },
      }),
    });
    const result = await runSync(fake.deps, { force: false });
    assert.equal(fake.calls.waited, 1);
    assert.equal(result.status, 'applied');
    assert.equal(fake.settings.get('prettier.singleQuote'), true);
  });

  it('reports settings that keep failing', async () => {
    const fake = createFake({
      failingSettings: ['unknown.setting'],
      config: config({ version: 1, settings: { 'unknown.setting': 1, 'editor.tabSize': 2 } }),
    });
    const result = await runSync(fake.deps, { force: false });
    assert.equal(result.status, 'partial');
    assert.equal(fake.calls.waited, 0);
    assert.match(result.errors[0], /unknown\.setting/);
    assert.equal(fake.settings.get('editor.tabSize'), 2);
  });

  it('does not throw when storing the state fails', async () => {
    const fake = createFake({ config: config({ version: 1 }) });
    fake.deps.state.setApplied = async () => {
      throw new Error('storage broken');
    };
    const result = await runSync(fake.deps, { force: false });
    assert.equal(result.status, 'applied');
    assert.match(fake.logs.join(), /storage broken/);
  });
});
