# Team Sync

Keep VS Code settings and extensions consistent across your whole team. Team Sync loads one central `team-config.json` from a URL, installs and removes extensions and writes the shared settings into every team member's user settings.

## Features

- **Central configuration**: one JSON file on any HTTPS server (internal web server, GitHub raw file, S3, ...).
- **Extensions**: installs missing extensions from `extensions.install`, so the shared settings work right away. Team Sync never uninstalls or disables any extension.
- **Settings**: writes every entry of `settings` into the user settings (global scope). `null` removes a setting.
- **Clean removal**: a setting deleted from the team config is reset on every client that still has the team value. Values a user changed personally stay.
- **Versioned**: changes are only applied when `version` changes, so personal tweaks are not overwritten every hour.
- **Automatic**: runs after VS Code has started and then every 60 minutes (configurable).
- **Private configs**: optional bearer token, stored in the operating system's secure storage.
- **Status bar**: shows the applied config version and the sync state, a click syncs immediately.
- **Robust**: network errors, invalid JSON or a missing URL are logged in the output channel "Team Sync" and never break VS Code.

## Setup

1. Install **Team Sync**.
2. Host a `team-config.json` (see below) on an HTTPS URL.
3. Open the settings and set **Team Sync: Config Url** (`teamSync.configUrl`), for example:

   ```json
   "teamSync.configUrl": "https://config.example.com/vscode/team-config.json"
   ```

   A file in a public GitHub repository works too, use its raw URL, e.g. `https://raw.githubusercontent.com/<owner>/<repo>/main/team-config.json` (GitHub caches raw files for a few minutes).

4. If the file is protected, run **Team Sync: Token setzen** from the command palette and enter the token. It is sent as `Authorization: Bearer <token>`.
5. Run **Team Sync: Jetzt synchronisieren** or click the status bar entry.

`teamSync.configUrl` can only be set in the user settings, a workspace cannot redirect it.

## Configuration file

```json
{
  "version": 1,
  "extensions": {
    "install": ["esbenp.prettier-vscode", "dbaeumer.vscode-eslint"]
  },
  "settings": {
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "[markdown]": { "files.trimTrailingWhitespace": false }
  }
}
```

| Field | Required | Description |
| --- | --- | --- |
| `version` | yes | Integer >= 0. Increase it on every change. Clients apply the config whenever it differs from the version they applied last. |
| `extensions.install` | no | Extension IDs (`publisher.name`) to install when missing. Extensions that are already installed, or not listed, are left alone. |
| `settings` | no | Settings written to the user settings. `null` removes a setting. Language overrides such as `"[markdown]"` are merged into the user's existing override (`null` inside removes a single entry), all other values replace the user's value. Settings of Team Sync itself (`teamSync.*`) cannot be set this way. |

Team Sync remembers which settings values it wrote. When a setting disappears from the config, it is removed from the user settings, but only if it still has the team value.

The file is validated before anything is applied. If one step fails (for example an extension cannot be installed), the remaining steps still run and the whole version is retried on the next sync.

Files named `team-config.json` get validation and completion in VS Code through a bundled JSON schema.

### Generate the file from settings.json and extensions.json

Instead of editing `team-config.json` by hand, the [source repository](https://github.com/marnis-tech/team-sync) contains a generator. Put the team settings into `team/settings.json` (same format as the VS Code `settings.json`, comments allowed) and the extensions into `team/extensions.json` (same format as `.vscode/extensions.json`: `recommendations` are installed), then run:

```sh
npm run team-config
```

It writes `team/team-config.json` and increases `version` only when something changed.

## Commands

| Command | Description |
| --- | --- |
| Team Sync: Jetzt synchronisieren | Loads the config and applies it, even if the version did not change. |
| Team Sync: Token setzen | Stores the bearer token (leave empty to remove it). |
| Team Sync: Token entfernen | Removes the stored token. |
| Team Sync: Log anzeigen | Opens the output channel "Team Sync". |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `teamSync.configUrl` | `""` | URL of `team-config.json`. HTTPS only, plain HTTP only for `localhost`. |
| `teamSync.syncIntervalMinutes` | `60` | Interval of the automatic sync in minutes (5 to 1440). |

## Security notes

Settings can change how VS Code and extensions behave, so only point `teamSync.configUrl` to a source your team controls. The token is stored in VS Code's secret storage and never written to logs; logs show the config URL without query string.

## License

[MIT](LICENSE)
