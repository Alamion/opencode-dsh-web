# AGENTS.md

Guidance for AI agents working on this repository.

## What this is

A VS Code extension that embeds the OpenCode and DeepSeek Harness (DSH) web UIs
in the secondary sidebar, pre-authenticated. It talks to local servers or to
Coder workspace apps.

## Layout

```
src/core/       pure logic; MUST NOT import `vscode` (kept testable)
src/providers/  vscode-facing providers, settings, proxy spawning
src/proxy/      plain-Node proxy children, bundled to dist/ by esbuild
tests/          vitest unit tests (core logic only)
scripts/        build
```

## Conventions

- TypeScript, ESM source, bundled to CommonJS by esbuild (`scripts/build.mjs`).
- Pure logic lives in `src/core` and is covered by vitest. Add tests for new
  pure functions.
- No hardcoded hosts, ports, absolute paths, credentials or deployment names.
  Everything user-specific is a setting with a sensible default.
- English only: code, comments, commit messages, docs.
- The proxy children bind to `127.0.0.1` only and must never be exposed.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run package
```

## Don't

- Don't commit `node_modules/`, `dist/` or `*.vsix`.
- Don't add telemetry or make network calls beyond the configured servers.
- Don't change `contributes` ids (`opencodeWeb.*`, `dshWeb.*`) without a
  migration note in the CHANGELOG.
