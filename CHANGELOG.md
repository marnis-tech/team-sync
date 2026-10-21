# Changelog

All notable changes to this extension are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-21

### Added

- Load `team-config.json` from `teamSync.configUrl`, optional bearer token via secret storage.
- Install missing extensions (never uninstalls anything), write user settings (`null` removes a setting).
- Reset settings that were removed from the team config, unless the user changed them.
- Apply only when `version` changed; "Team Sync: Jetzt synchronisieren" forces a sync.
- Sync after startup and every 60 minutes (`teamSync.syncIntervalMinutes`).
- Status bar entry with config version and sync state.
- JSON schema for `team-config.json`.
- Generator that builds `team-config.json` from `settings.json` and `extensions.json`.
