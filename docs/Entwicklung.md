# Team Sync: Entwicklung, Pflege und Release

## Überblick

Team Sync lädt eine zentrale `team-config.json` von der URL aus `teamSync.configUrl`, installiert fehlende Extensions und schreibt Einstellungen in die User Settings der Teammitglieder. Extensions werden nie deinstalliert oder deaktiviert: Team Sync ergänzt nur, was für die gemeinsamen Settings gebraucht wird. Angewendet wird nur, wenn sich `version` gegenüber der zuletzt angewendeten Version (im `globalState`) unterscheidet. Die README.md ist die Marketplace-Seite und deshalb englisch.

## Aufbau

| Datei | Aufgabe |
| --- | --- |
| `src/extension.ts` | Aktivierung, Befehle, Timer, Benachrichtigungen, `SyncController` (immer nur ein Sync gleichzeitig) |
| `src/sync.ts` | Sync-Ablauf ohne VS-Code-Abhängigkeit: installieren, Einstellungen schreiben, gestrichene Einstellungen zurücksetzen, Stand speichern |
| `src/loadConfig.ts` | Abruf per `fetch` (Timeout, HTTPS-Pflicht, Token), JSON-Parsing, Fehlermeldungen |
| `src/config.ts` | Typen und Laufzeit-Validierung der `team-config.json` |
| `src/vscodeAdapters.ts` | Anbindung von `sync.ts` an die VS Code API (Extensions, Settings, globalState, SecretStorage) |
| `src/statusBar.ts` | Status-Bar-Eintrag |
| `src/teamConfigBuilder.ts`, `src/cli/buildTeamConfig.ts` | Generator: `team/settings.json` + `team/extensions.json` werden zu `team/team-config.json` |
| `src/util/json.ts` | JSONC-Parser (Kommentare, Trailing Commas), Vergleich von JSON-Werten |
| `schemas/team-config.schema.json` | JSON-Schema, das VS Code für Dateien namens `team-config.json` nutzt |
| `test/*.test.ts` | Unit-Tests mit `node:test`, ohne VS Code |

Die Logik in `sync.ts`, `loadConfig.ts` und `config.ts` kennt VS Code nicht und ist deshalb vollständig per Unit-Test prüfbar. Alles, was die VS Code API braucht, steckt in `vscodeAdapters.ts`, `statusBar.ts` und `extension.ts`.

## Verhalten im Detail

- Reihenfolge: erst fehlende Extensions installieren, dann Einstellungen. So sind Einstellungen neu installierter Extensions möglichst schon registriert. Schlägt eine Einstellung trotzdem fehl, wartet der Sync einmal auf die Registrierung (max. 5 s) und versucht es erneut.
- Teilfehler: Schlägt ein Schritt fehl, laufen die übrigen weiter. Der Stand wird dann nicht gespeichert, der nächste Sync versucht alles erneut (bereits installierte Extensions und gleiche Einstellungen werden übersprungen).
- Gestrichene Einstellungen: Im `globalState` (`teamSync.appliedState`) liegen die zuletzt angewendete Version und die Werte, die die Team-Konfiguration gesetzt hat. Fehlt eine Einstellung in einer neuen Version, wird sie beim Nutzer entfernt, aber nur, wenn sie noch den Team-Wert hat. Hat der Nutzer sie selbst geändert, bleibt sie. Bei Sprach-Overrides gilt das pro Eintrag. Kann eine Einstellung nicht zurückgesetzt werden (meist, weil die zugehörige Extension fehlt), gibt es nur eine Warnung im Log.
- `null` als Wert in `settings` entfernt die Einstellung aus den User Settings.
- Einstellungen `teamSync.*` sind von der Team-Konfiguration ausgenommen, und `teamSync.configUrl` hat `scope: application`. Ein Workspace oder die Team-Konfiguration selbst kann die Quelle also nicht umbiegen.
- Wird `teamSync.configUrl` geändert, folgt sofort ein erzwungener Sync, weil eine neue Quelle Versionsnummern wiederverwenden kann.
- Benachrichtigungen: Bei automatischen Syncs nur, wenn sich etwas geändert hat. Fehler zeigt dann nur die Status-Bar, Details stehen im Output "Team Sync". Beim manuellen Sync wird immer ein Ergebnis angezeigt.

## Team-Konfiguration pflegen

1. `team/settings.json` bearbeiten (Format wie die VS Code `settings.json`, Kommentare erlaubt).
2. `team/extensions.json` bearbeiten (Format wie `.vscode/extensions.json`: `recommendations` werden installiert, wenn sie fehlen; alternativ `install`). `unwantedRecommendations` wird mit einer Warnung ignoriert, Team Sync deinstalliert nichts. Eine Datei `extension.json` wird ebenfalls erkannt. Eine Einstellung entfernen: einfach aus `settings.json` löschen (wird bei allen zurückgesetzt, die noch den Team-Wert haben) oder ausdrücklich auf `null` setzen (wird immer entfernt).
3. `npm run team-config` ausführen. Der Generator schreibt `team/team-config.json` und erhöht `version` nur, wenn sich Inhalte geändert haben. Mit `-- --version 10` lässt sich die Version fest vorgeben.
4. Committen und nach `main` pushen. Die Teammitglieder tragen einmalig als `teamSync.configUrl` ein:
   `https://raw.githubusercontent.com/marnis-tech/team-sync/main/team/team-config.json`
   (öffentliches Repo, kein Token nötig; GitHub cached Raw-Dateien einige Minuten, "Jetzt synchronisieren" holt dann den neuen Stand).

Die CI prüft mit `npm run team-config -- --check`, dass die generierte Datei zum Stand von `settings.json` und `extensions.json` passt.

Hinweis: Wird die Quelle für mehrere Teams gebraucht, reicht ein weiterer Ordner, z. B. `npm run team-config -- --dir teams/frontend`.

## Lokale Entwicklung

```sh
npm install
npm run build        # Typecheck + Bundle nach dist/extension.js
npm test             # Unit-Tests
npm run watch        # Bundle bei Änderungen neu bauen
npm run package      # team-sync-<version>.vsix erzeugen
```

Zum Ausprobieren in VS Code: `npm run package`, dann `code --install-extension team-sync-<version>.vsix`, oder per F5 einen Extension Development Host starten (dafür ggf. eine `launch.json` mit `"type": "extensionHost"` anlegen). Zum lokalen Testen der Config reicht `npx http-server team -p 8080` o. ä. und `teamSync.configUrl` = `http://localhost:8080/team-config.json` (HTTP ist nur für localhost erlaubt).

## Anpassungen an der Extension

- Neue Felder in der `team-config.json`: Typ und Validierung in `src/config.ts`, Anwendung in `src/sync.ts`, Schema in `schemas/team-config.schema.json`, Tests ergänzen. Unbekannte Felder erzeugen in älteren Versionen nur eine Warnung, neue Felder brechen alte Installationen also nicht.
- Neue Einstellungen der Extension: `contributes.configuration` in `package.json`, Zugriff über `vscode.workspace.getConfiguration('teamSync')`.
- Neue Befehle: `contributes.commands` in `package.json` und `registerCommand` in `src/extension.ts`.
- Texte der Oberfläche sind Deutsch, Code und Kommentare Englisch.

## Release (Update der Extension)

1. Änderungen umsetzen, `npm run build` und `npm test` lokal grün.
2. In `CHANGELOG.md` die Einträge unter `[Unreleased]` in einen neuen Abschnitt `[x.y.z] - JJJJ-MM-TT` verschieben.
3. Version erhöhen und Tag erzeugen: `npm version patch` (Fehlerbehebung), `npm version minor` (neue Funktion) oder `npm version major` (inkompatible Änderung). Das erzeugt einen Commit und den Tag `vx.y.z`.
4. `git push --follow-tags`.
5. Der Workflow `.github/workflows/release.yml` startet beim Tag `v*`: prüft, dass Tag und `package.json`-Version übereinstimmen, baut, testet, packt die VSIX, veröffentlicht im Visual Studio Marketplace (Secret `VSCE_PAT`) und auf Open VSX (Secret `OVSX_PAT`) und hängt die VSIX an ein GitHub-Release.

VS Code aktualisiert installierte Extensions aus dem Marketplace automatisch, die Teammitglieder müssen nichts tun.

### Einmalige Einrichtung für die Veröffentlichung

- Publisher `marnis-tech` im [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage) anlegen. Personal Access Token in Azure DevOps mit Scope "Marketplace: Manage" erzeugen und als Repository-Secret `VSCE_PAT` hinterlegen.
- Open VSX:
  1. Eclipse-Konto auf [accounts.eclipse.org](https://accounts.eclipse.org/user/register) anlegen und im Profil den GitHub-Benutzernamen eintragen.
  2. Auf [open-vsx.org](https://open-vsx.org) mit GitHub anmelden.
  3. Unter Avatar > Settings das Eclipse-Konto verbinden ("Log in with Eclipse") und das Publisher Agreement unterschreiben.
  4. Unter Settings > Access Tokens einen Token erzeugen (wird nur einmal angezeigt).
  5. Namespace anlegen: `npx ovsx create-namespace marnis-tech -p <token>` (Token nicht in Shell-History lassen, z. B. vorher `read -s OVSX_PAT` und `-p "$OVSX_PAT"`).
  6. Token als Secret hinterlegen: `gh secret set OVSX_PAT --repo marnis-tech/team-sync` (fragt den Wert verdeckt ab).
  7. Optional: Namespace-Inhaberschaft per Issue im Repo [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org/issues) beantragen, dann erscheint die Extension als "verifiziert".

## Bekannte Grenzen

- Mehrere offene Fenster synchronisieren jeweils selbst. Das ist unkritisch (alle Schritte sind idempotent), kann aber doppelte Benachrichtigungen erzeugen.
- Die angewendete Version liegt im `globalState`. Ob VS Code diesen pro Profil trennt, ist noch nicht im echten Betrieb geprüft; im Zweifel in einem anderen Profil "Team Sync: Jetzt synchronisieren" ausführen.
- Deaktivierte Extensions gelten für die VS Code API (`getExtension`) als nicht installiert. Steht eine solche Extension in `install`, ruft Team Sync die Installation erneut auf; sie wird dadurch aber nicht aktiviert.
- Der Abruf nutzt das native `fetch` von Node. Hinter einem Firmen-Proxy oder TLS-Inspection kann der Abruf mit einem Netzwerkfehler scheitern; dann die Config-URL intern erreichbar machen.
- Sprach-Overrides wie `"[markdown]"` werden mit den persönlichen Overrides zusammengeführt, alle anderen Werte (auch Objekte wie `files.exclude`) ersetzen den Wert des Nutzers vollständig.
