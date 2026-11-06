# OpenCode & DSH Web (Sidebar)

![OpenCode & DSH Web — two web UIs in the VS Code sidebar](media/banner.png)

Open the [OpenCode](https://opencode.ai) web UI and the DeepSeek Harness (DSH)
web UI in the VS Code **secondary sidebar** (the right column, next to the
Claude Code / Codex panels) — pre-authenticated, at your project and last chat,
locally or as a Coder workspace app.

Two webview panels:

- **OpenCode** — the official OpenCode web UI, reached through a local
  authenticating proxy, deep-linked to the last chat of the current folder.
- **DSH** — the DeepSeek Harness web UI (`dsh --profile web`), either the local
  server or a Coder workspace app such as DUST, with automatic sign-in.

## Screenshots

<!-- Uncomment once real screenshots are committed under docs/screenshots/.
![OpenCode panel in the VS Code sidebar](docs/screenshots/opencode.png)
![DSH as a Coder workspace app](docs/screenshots/dsh-coder.png)
![DSH workspace stopped state](docs/screenshots/dsh-stopped.png)
-->

Screenshots live in [`docs/screenshots`](docs/screenshots). See that folder for
the shot list.

## Requirements

- VS Code 1.90 or newer.
- For the OpenCode panel: a reachable OpenCode server (`opencode serve` /
  `opencode service start`, default `http://127.0.0.1:4096`).
- For the DSH panel: either a local `dsh` on `PATH` (or an already running DSH
  web GUI), or a Coder deployment with a logged-in session.

## Install

From the Marketplace search for **OpenCode & DSH Web**, or install a packaged
build:

```bash
code --install-extension opencode-dsh-web-0.1.0.vsix
```

## Quick start

| Action | Default key |
| --- | --- |
| Open the OpenCode panel | `Alt+O` |
| Open the DSH panel | `Alt+D` |

Both panels also expose buttons in the view title bar and an
`OpenCode Web: Open Sidebar` button in the editor title bar.

## OpenCode

The extension starts a small local proxy that talks to your OpenCode server and
adds the HTTP Basic credentials, so the panel is signed in without a login form
or pair link. The password comes from `opencodeWeb.password`, or from
`~/.config/opencode/service.json` when the setting is empty.

Each workspace folder gets its own stable proxy port, so the panel keeps an
isolated webview origin — and with it the OpenCode UI state (the selected
project and the open chats). Whenever the panel is opened (including after a
window reload) it deep-links to the **last chat you opened** in the current
folder, rather than the all-sessions list.

## DSH

`dshWeb.mode` selects the target:

- `auto` (default) — use Coder when a deployment URL and session are found,
  otherwise the local DSH server.
- `coder` — only a Coder workspace app.
- `local` — only a local `dsh --profile <profile>` server.

### Local DSH

With `dshWeb.mode` set to `local`, the panel talks to `dshWeb.url`
(default `http://127.0.0.1:3080`). If it is unreachable and `dshWeb.autoStart`
is on, the extension starts `dsh --profile <dshWeb.profile> --no-open` and
remembers the authenticated launch URL it prints.

DSH authenticates a browser with a one-shot launch token that mints a signed
`dsh-auth-*` cookie. If the extension did not see the launch URL, the panel asks
you to paste the `dsh web: <url>` line once.

### DSH as a Coder workspace app

A Coder workspace app lives on a subdomain of the deployment,
`<slug>[--<agent>]--<workspace>--<owner>.<appDomain>`, and is protected by the
Coder session. VS Code webviews keep cookies in a separate jar, so the panel
reaches the app through a local proxy that injects the `Coder-Session-Token`
header. The proxy also completes DSH's own launch-token exchange **server-side**
and holds the `dsh-auth` cookie itself, so the webview needs no cookie at all
(this is what keeps the panel from looping and hitting Coder's rate limit).

The panel:

1. Reads the deployment URL and session token from settings or from disk
   (`~/.config/coderv2/url`, `~/.config/coderv2/session`, or the `coder-remote`
   extension's global storage).
2. Resolves the owner (the logged-in user) and a workspace (an explicit
   `$CODER_WORKSPACE_NAME`, the only owned workspace, the only running one, or
   the most recently used one).
3. Resolves the app slug: `dshWeb.coder.appSlug` when set, otherwise the single
   app of a running workspace. With several apps it asks you to pick one
   (**DSH Web: Select Coder App**), which stores `dshWeb.coder.appSlug`.
4. If the workspace is not running, shows its status and a **Start workspace**
   button (or starts it automatically when `dshWeb.coder.autoStartWorkspace` is
   on) and waits until the app answers.
5. Starts the local proxy on a stable port and opens the app.

If the Coder session expires, the panel offers **DSH Web: Coder Login**.

## Settings

### OpenCode

| Setting | Default | Description |
| --- | --- | --- |
| `opencodeWeb.serverUrl` | `http://127.0.0.1:4096` | OpenCode server URL. |
| `opencodeWeb.password` | *(from service.json)* | Server password. |
| `opencodeWeb.autoStart` | `true` | Run `opencode service start` when the server is unreachable. |
| `opencodeWeb.deepLink` | `always` | Open the last chat: `always`, `first`, or `never`. |

### DSH

| Setting | Default | Description |
| --- | --- | --- |
| `dshWeb.mode` | `auto` | `auto`, `coder`, or `local`. |
| `dshWeb.url` | `http://127.0.0.1:3080` | Local DSH web GUI (in `local` mode). |
| `dshWeb.profile` | `web` | Profile to boot for a local DSH. |
| `dshWeb.autoStart` | `true` | Boot the local DSH when it is unreachable. |
| `dshWeb.coder.url` | *(from `~/.config/coderv2/url`)* | Coder deployment URL. |
| `dshWeb.coder.sessionPath` | *(auto)* | Path to the Coder session-token file. |
| `dshWeb.coder.token` | `""` | Session token used directly (overrides `sessionPath`). |
| `dshWeb.coder.appSlug` | `""` | App slug to open; empty means auto-detect. |
| `dshWeb.coder.appDomain` | *(deployment host)* | Domain the app hosts live on. |
| `dshWeb.coder.workspace` | *(auto)* | Workspace name. |
| `dshWeb.coder.owner` | *(logged-in user)* | Workspace owner. |
| `dshWeb.coder.agent` | `""` | Agent label to include in the app URL. |
| `dshWeb.coder.autoStartWorkspace` | `false` | Start a stopped workspace automatically. |
| `dshWeb.coder.cli` | *(auto)* | Path to the `coder` CLI for the Login command. |

## Commands

- **OpenCode Web: Open Sidebar** (`Alt+O`)
- **OpenCode Web: New Session**
- **OpenCode Web: Open in System Browser**
- **OpenCode Web: Reload**
- **DSH Web: Open Sidebar** (`Alt+D`)
- **DSH Web: Reload**
- **DSH Web: Open in System Browser**
- **DSH Web: Start Coder Workspace**
- **DSH Web: Select Coder App**
- **DSH Web: Coder Login**

## How it works

Both panels render a webview that embeds the target UI in an iframe. Each target
is fronted by a local `127.0.0.1` proxy child process (started with
`ELECTRON_RUN_AS_NODE`) so that VS Code's own proxy support
(`http.proxySupport=override`) cannot intercept `http.request` and hang up on
the loopback target:

- The OpenCode proxy injects `Authorization: Basic opencode:<password>`.
- The Coder proxy injects `Coder-Session-Token`, forces `Host`/`Origin` to the
  app host, and performs DSH's launch-token exchange itself.

The proxies bind to `127.0.0.1` only, and their ports are derived from the
workspace path or the Coder target, so the webview origin stays stable across
reloads.

## Security

- The proxies listen on loopback only. Anyone who can reach that loopback port
  gains the injected credentials, so do not expose it.
- The Coder session token is read from disk (or settings) and never leaves your
  machine except to your own deployment.
- Nothing is telemetry-tracked by this extension.

## Troubleshooting

- **"Coder is not configured"** — set `dshWeb.coder.url` or log in with the
  coder CLI so `~/.config/coderv2` exists.
- **"Coder session expired"** — run **DSH Web: Coder Login**.
- **"Select a Coder app"** — the workspace exposes several apps; run
  **DSH Web: Select Coder App** or set `dshWeb.coder.appSlug`.
- **"Workspace ... is stopped"** — use **Start workspace**, or enable
  `dshWeb.coder.autoStartWorkspace`.
- **OpenCode panel shows the sessions list** — set `opencodeWeb.deepLink` to
  `always` (the default) so it re-opens the last chat.

## Development

```bash
npm install
npm run build        # bundles dist/extension.js and the two proxy children
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run package      # build + vsce package
```

Source layout:

```
src/core/       pure logic (no vscode import): URLs, ports, Coder resolution,
                cookies, HTML builders
src/providers/  vscode-facing providers, settings and proxy spawning
src/proxy/      the two plain-Node proxy children (bundled to dist)
tests/          vitest unit tests for the core logic
```

## License

MIT
