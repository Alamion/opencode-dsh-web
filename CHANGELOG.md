# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-12

### Fixed

- OpenCode HTTP(S) links, including local launch URLs and popup links, open in
  the system browser instead of being blocked inside the sidebar iframe.
- Preserve the visible chat message when hiding/revealing the OpenCode panel
  and when appearance synchronization reloads it in the background. Intentional
  scrolling and bottom-follow remain available.
- Install the iframe integration with appearance sync disabled and in the
  fallback proxy, while retaining the upstream Content Security Policy.

## [0.1.0] - 2026-11-07

### Added

- OpenCode web UI panel in the secondary sidebar, pre-authenticated through a
  local proxy, deep-linked to the last chat of the current folder.
- DSH web UI panel: local server (`dsh --profile <profile>`) or a Coder
  workspace app, with automatic sign-in.
- Optional Coder mode for both panels, including automatic workspace and app
  resolution, stopped-workspace actions and server-side Coder auth.
- `opencodeWeb.mode`: `local`, `coder`, or `auto` (Coder when
  `dshWeb.coder.workspace` is set, otherwise local).
- `opencodeWeb.syncAppearance`: shared OpenCode theme, color scheme and
  Appearance settings with live theme updates over SSE.
- `opencodeWeb.syncPreferences`: optional shared general preferences,
  keybindings, notifications, sounds, language and motion tuning.
- **OpenCode Web: Reset Shared Appearance** command.
- First-run **Connect to OpenCode** form (server URL and password) when the
  local server is unreachable or the password is missing.
- `opencodeWeb.openOnStartup` and `dshWeb.openOnStartup` settings.
- URI handlers: `vscode://Alamion.opencode-dsh-web/open-opencode` and
  `/open-dsh`.
- **DSH Web: Set Launch URL** for refreshing a local DSH launch token.
- Per-workspace and per-target stable proxy ports so the webview origin (and UI
  state) survives window reloads.
- Keybindings `Alt+O` (OpenCode) and `Alt+D` (DSH).
- Real Marketplace screenshots, badge row and regenerated icon.

### Fixed

- Local DSH is proxied through the extension, so its `SameSite=Strict` auth
  cookie works inside a VS Code webview.
- The OpenCode password is re-read after `opencode service start` creates
  `service.json`.
