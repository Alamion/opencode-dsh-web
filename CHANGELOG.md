# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `opencodeWeb.syncAppearance`: share the OpenCode web UI appearance
  (theme, color scheme and Appearance settings) across VS Code windows by
  injecting a shared profile into the proxy origin, with live theme updates
  over SSE.
- `opencodeWeb.syncPreferences`: optionally share general preferences,
  keybindings, notifications, sounds, language and motion tuning.
- **OpenCode Web: Reset Shared Appearance** command.
- First-run **Connect to OpenCode** form (server URL and password) when the
  local server is unreachable or the password is missing.
- `opencodeWeb.openOnStartup` and `dshWeb.openOnStartup` settings.
- URI handlers: `vscode://Alamion.opencode-dsh-web/open-opencode` and
  `/open-dsh`.
- **DSH Web: Set Launch URL** for refreshing a local DSH launch token.
- Real Marketplace screenshots and regenerated banner/icon.

### Fixed

- Local DSH is proxied through the extension, so its `SameSite=Strict` auth
  cookie works inside a VS Code webview.
- The OpenCode password is re-read after `opencode service start` creates
  `service.json`.

## [0.1.0] - 2026-11-06

### Added

- OpenCode web UI panel in the secondary sidebar, pre-authenticated through a
  local proxy, deep-linked to the last chat of the current folder.
- DSH web UI panel: local server (`dsh --profile <profile>`) or a Coder
  workspace app, with automatic sign-in.
- Coder app support: session detection, workspace and app resolution, workspace
  start, app picker and a login command.
- Per-workspace and per-target stable proxy ports so the webview origin (and UI
  state) survives window reloads.
- Keybindings `Alt+O` (OpenCode) and `Alt+D` (DSH).
