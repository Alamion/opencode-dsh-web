import * as vscode from 'vscode';
import { opencodeFrame } from '../core/html';
import { basicAuth, OpenCodeSession, parseCreatedSessionId, pickLatestSession, sessionDeepLink } from '../core/opencode';
import { opencodeConfig } from './settings';

export const OPENCODE_VIEW = 'opencodeWeb.sidePanel';

type DeepLinkMode = 'always' | 'first' | 'never';

/** The OpenCode web UI, pre-authenticated through the local proxy. */
export class OpenCodeProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly proxyUrl: string,
    private readonly serverUrl: string,
    private readonly password: string,
  ) {}

  get isOpen(): boolean {
    return this.view !== undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    void this.render();
  }

  async render(): Promise<void> {
    if (!this.view) return;
    this.view.webview.html = await this.html();
  }

  async html(): Promise<string> {
    const config = opencodeConfig();
    const deepLink = config.get<DeepLinkMode>('deepLink', 'always');
    let target = this.proxyUrl + '/';

    const folder = (vscode.workspace.workspaceFolders ?? [])[0];
    if (folder && deepLink !== 'never') {
      const key = 'opencodeWeb.linked.' + folder.uri.fsPath;
      const opened = this.context.workspaceState.get<boolean>(key, false);
      // 'always' (default): every time the panel is (re)resolved - for example
      // after a window reload - jump straight to the last chat opened in this
      // project instead of the all-sessions list. 'first' keeps the old
      // once-per-workspace behaviour.
      if (deepLink === 'always' || !opened) {
        const sessionId = await this.latestSession(folder.uri.fsPath);
        if (sessionId) {
          target = sessionDeepLink(this.proxyUrl, sessionId);
          await this.context.workspaceState.update(key, true);
        }
      }
    }

    return opencodeFrame(this.proxyUrl, target);
  }

  /** Create a session in the current folder and open it in the panel. */
  async createSession(): Promise<void> {
    const folder = (vscode.workspace.workspaceFolders ?? [])[0];
    if (!folder) return;
    await vscode.window.withProgress({ location: { viewId: OPENCODE_VIEW }, title: 'Creating session…' }, async () => {
      const response = await fetch(this.serverUrl + '/api/session', {
        method: 'POST',
        headers: { Authorization: basicAuth(this.password), 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: folder.uri.fsPath, title: 'New session' }),
      }).catch(() => null);
      if (!response || !response.ok) return;
      const sessionId = parseCreatedSessionId(await response.json());
      if (sessionId) {
        void this.view?.webview.postMessage({ type: 'navigate', url: sessionDeepLink(this.proxyUrl, sessionId) });
      }
    });
  }

  private async latestSession(directory: string): Promise<string | null> {
    try {
      const response = await fetch(this.serverUrl + '/api/session?directory=' + encodeURIComponent(directory), {
        headers: { Authorization: basicAuth(this.password) },
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { data?: OpenCodeSession[] };
      return pickLatestSession(body.data ?? []);
    } catch {
      return null;
    }
  }
}
