# Spec: VS Code extension "team-sync"

Build a VS Code extension "team-sync" (publisher: marnis-tech) in TypeScript that centrally syncs user settings and extensions for a team.

## Behaviour
- Activation: `onStartupFinished`, then a sync every 60 minutes (setting `teamSync.syncIntervalMinutes`, minimum 5).
- Loads `team-config.json` from the URL in setting `teamSync.configUrl` (scope `application`, so a workspace cannot override it). HTTPS only, plain HTTP only for localhost. Timeout 15 s, response limit 1 MB.
- Optional bearer token stored in SecretStorage. Commands: "Team Sync: Token setzen" (empty input removes it), "Team Sync: Token entfernen", "Team Sync: Log anzeigen".
- Order of a sync: install missing `extensions.install` (via `workbench.extensions.installExtension`), then write every entry of `settings` with `ConfigurationTarget.Global`. The extension never uninstalls or disables any extension; it only adds missing ones so the shared settings work. A `null` value removes the user setting. Unchanged values are not rewritten. Language overrides like `"[markdown]"` are merged into the user's existing override. If settings fail after new installs, wait once for `vscode.extensions.onDidChange` (max 5 s) and retry.
- Store the applied version and the settings values the team config set in `globalState`. When a setting is dropped from the team config, remove it from the user settings only if it still has the team value (per entry for language overrides); failures there are warnings only.
- Applies only when `version` differs from the version stored in `globalState`. The version is stored only if every step succeeded; otherwise the next sync retries. Command "Team Sync: Jetzt synchronisieren" forces a sync. Changing `teamSync.configUrl` triggers a forced sync.
- Status bar item with applied config version and sync state (syncing, ok, partial, error, not configured); click runs the forced sync.
- All errors (network, HTTP status, invalid JSON, invalid format, missing URL) are caught and logged in the log output channel "Team Sync"; the extension never throws. Logs never contain the token or the URL query string.
- UI strings are German.

## team-config.json
```json
{
  "version": 1,
  "extensions": { "install": ["publisher.name"] },
  "settings": { "editor.formatOnSave": true }
}
```
Runtime validation: root object; `version` integer >= 0 (required); `extensions` and `settings` optional objects; extension IDs match `publisher.name`; `extensions.uninstall` is ignored with a warning; settings keys starting with `teamSync.` are an error; unknown keys and duplicate IDs are warnings only. Ship a JSON schema and register it via `contributes.jsonValidation` for `team-config.json`.

## Generator
`npm run team-config` builds `team/team-config.json` from `team/settings.json` (JSONC, VS Code settings format) and `team/extensions.json` (JSONC, `.vscode/extensions.json` format: `recommendations` = install, `unwantedRecommendations` ignored with a warning; `install` also accepted; `extension.json` also accepted). The version is increased only when content changed; `--version N` sets it explicitly, `--check` fails if the file is outdated. An unreadable previous file without `--version` is an error (never reset the version).

## Project
- Node 22, esbuild bundle (`dist/extension.js`, cjs, external `vscode`), native fetch, no runtime dependencies.
- Marketplace-ready `package.json`: displayName, description, license MIT, repository, icon, categories, `engines.vscode` ^1.90.0, `@types/vscode` 1.90.0.
- README.md (marketplace page, English) with setup and example config, LICENSE, `.vscodeignore` (ship only bundle, schema, icon, docs), CHANGELOG.md, `example/team-config.json`.
- Unit tests with `node:test` for validation, loading and sync logic (sync logic must not import `vscode`; inject dependencies).
- GitHub Actions: CI on push/PR (build, test, generator check, package); release on tag `v*`: check tag equals package.json version, build, test, `vsce package`, `vsce publish` (secret `VSCE_PAT`), `ovsx publish` (secret `OVSX_PAT`), attach VSIX to a GitHub release.
- Verify that `npm run build`, the tests and `vsce package` succeed.
