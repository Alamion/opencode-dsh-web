import * as vscode from 'vscode';
import { dshMessage, opencodeFrame, opencodeSetup } from '../core/html';
import { basicAuth, OpenCodeSession, parseCreatedSessionId, pickLatestSession, sessionDeepLink } from '../core/opencode';
import { opencodeConfig } from './settings';

export const OPENCODE_VIEW = 'opencodeWeb.sidePanel';

type DeepLinkMode = 'always' | 'first' | 'never';

interface WebviewMessage {
  type?: string;
  serverUrl?: string;
  password?: string;
}

/** The OpenCode web UI, pre-authenticated through the local proxy. */
export class OpenCodeProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private setupError = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private proxyUrl: string,
    private serverUrl: string,
    private password: string,
    private readonly connect: (settings?: { serverUrl?: string; password?: string }) => Promise<boolean>,
    private readonly coderMode = false,
    private directory = '',
  ) {}

  get isOpen(): boolean {
    return this.view !== undefined;
  }

  setConnection(proxyUrl: string, serverUrl: string, password: string, error = '', directory = this.directory): void {
    this.proxyUrl = proxyUrl;
    this.serverUrl = serverUrl;
    this.password = password;
    this.setupError = error;
    this.directory = directory;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === 'connect') {
        void this.connect({
          serverUrl: message.serverUrl ?? '',
          password: message.password ?? '',
        }).then((ok) => {
          if (ok) this.setupError = '';
          else if (!this.setupError) this.setupError = 'Could not reach the OpenCode server.';
          return this.render();
        });
      } else if (message.type === 'retry') {
        void this.connect().then((ok) => {
          if (ok) this.setupError = '';
          else if (!this.setupError) this.setupError = 'Could not connect to OpenCode.';
          return this.render();
        });
      } else if (message.type === 'openSettings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'opencodeWeb');
      }
    });
    void this.render();
  }

  async render(): Promise<void> {
    if (!this.view) return;
    this.view.webview.html = await this.html();
  }

  async html(): Promise<string> {
    if (!this.proxyUrl) {
      if (this.coderMode) {
        return dshMessage(
          'OpenCode via Coder is not ready',
          this.setupError || 'Set <code>opencodeWeb.coder.*</code> and the Coder workspace, then retry.',
          [
            { act: 'retry', label: 'Retry' },
            { act: 'openSettings', label: 'Open Settings' },
          ],
        );
      }
      return opencodeSetup(this.serverUrl, this.password !== '', this.setupError);
    }
    const config = opencodeConfig();
    const deepLink = config.get<DeepLinkMode>('deepLink', 'always');
    let target = this.proxyUrl + '/';

    const folder = (vscode.workspace.workspaceFolders ?? [])[0];
    const directory = this.directory || folder?.uri.fsPath || '';
    if (directory && deepLink !== 'never') {
      const key = 'opencodeWeb.linked.' + directory;
      const opened = this.context.workspaceState.get<boolean>(key, false);
      // 'always' (default): every time the panel is (re)resolved - for example
      // after a window reload - jump straight to the last chat opened in this
      // project instead of the all-sessions list. 'first' keeps the old
      // once-per-workspace behaviour.
      if (deepLink === 'always' || !opened) {
        const sessionId = await this.latestSession(directory);
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
    const directory = this.directory || folder?.uri.fsPath || '';
    if (!directory) return;
    await vscode.window.withProgress({ location: { viewId: OPENCODE_VIEW }, title: 'Creating session…' }, async () => {
      const response = await fetch(this.serverUrl + '/api/session', {
        method: 'POST',
        headers: { Authorization: basicAuth(this.password), 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: { directory }, title: 'New session' }),
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
      if (!response.ok) {
        console.warn('[opencode] session list failed with HTTP ' + response.status);
        return null;
      }
      const body = (await response.json()) as { data?: OpenCodeSession[] };
      return pickLatestSession(body.data ?? []);
    } catch (error) {
      console.warn('[opencode] session list failed:', (error as Error).message);
      return null;
    }
  }
}
