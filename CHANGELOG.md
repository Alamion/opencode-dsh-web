# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
