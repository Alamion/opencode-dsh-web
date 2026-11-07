import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CoderTarget, isAppReady, listCoderApps, resolveTarget, startWorkspace } from '../core/coder';
import { dshFrame, dshMessage, dshTokenPrompt } from '../core/html';
import { choosePort } from '../core/net';
import { sleep, stripTrailingSlash } from '../core/util';
import { ProxyChild, startCoderProxyChild } from './proxy';
import { coderSettings, dshConfig, readCoderDeployment } from './settings';

export const DSH_VIEW = 'dshWeb.sidePanel';

type Mode = 'auto' | 'coder' | 'local';

interface CoderProxy extends ProxyChild {
  key: string;
}

interface WebviewMessage {
  type?: string;
  url?: string;
}

async function dshHealth(url: string): Promise<number | 'down'> {
  try {
    const response = await fetch(url + '/', { redirect: 'manual', signal: AbortSignal.timeout(2500) });
    return response.status === 200 || response.status === 401 ? response.status : 'down';
  } catch {
    return 'down';
  }
}

/** Boot `dsh --profile <profile>` and remember the launch URL it prints. */
async function ensureDshLocal(url: string, profile: string, context: vscode.ExtensionContext): Promise<number | 'down'> {
  let status = await dshHealth(url);
  if (status !== 'down') return status;
  if (!dshConfig().get<boolean>('autoStart', true)) return 'down';

  let port = '3080';
  try {
    port = new URL(url).port || '3080';
  } catch {
    // keep the default port
  }

  let tokenUrl: string;
  try {
    tokenUrl = await new Promise<string>((resolve, reject) => {
      const child = cp.spawn('dsh', ['--profile', profile, '--no-open', '--port', port], { stdio: ['ignore', 'pipe', 'pipe'] });
      let buffer = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('dsh did not print a URL in time'));
      }, 45000);
      const onData = (data: Buffer): void => {
        buffer += data.toString();
        const match = buffer.match(/dsh web: (\S+)/);
        if (!match) return;
        clearTimeout(timer);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        child.removeAllListeners('exit');
        resolve(match[1]);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', () => {
        clearTimeout(timer);
        reject(new Error('dsh exited before printing a URL'));
      });
    });
  } catch (error) {
    console.warn('[dsh] autostart failed:', (error as Error).message);
    return 'down';
  }

  await context.globalState.update('dshWeb.tokenUrl.' + profile, tokenUrl);
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(750);
    status = await dshHealth(url);
    if (status !== 'down') return status;
  }
  return 'down';
}

/** The DSH web UI: a local server, or a Coder workspace app. */
export class DshProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private coderProxy?: CoderProxy;
  private localProxy?: ProxyChild;
  private localProxyKey = '';
  private busy = false;
  private autoStarted = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    void this.render();
    view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.onMessage(message));
  }

  async render(): Promise<void> {
    if (!this.view) return;
    this.view.webview.html = await this.html();
  }

  dispose(): void {
    this.coderProxy?.dispose();
    this.coderProxy = undefined;
    this.disposeLocalProxy();
  }

  private disposeLocalProxy(): void {
    this.localProxy?.dispose();
    this.localProxy = undefined;
    this.localProxyKey = '';
  }

  /** Store a fresh `dsh web: <url>` launch URL and reload the panel. */
  async setLaunchToken(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    await this.context.globalState.update('dshWeb.tokenUrl.' + this.localProfile(), trimmed);
    this.disposeLocalProxy();
    await this.render();
  }

  async html(): Promise<string> {
    return this.mode() === 'coder' ? this.coderHtml() : this.localHtml();
  }

  /** URL to open in the system browser: the running proxy, else the local one. */
  externalUrl(): string {
    return this.coderProxy?.url ?? this.localUrl();
  }

  /** Start a stopped workspace and wait until its app answers. */
  async startCoder(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const deployment = readCoderDeployment();
      const target = await resolveTarget(deployment, coderSettings(), { envWorkspace: process.env.CODER_WORKSPACE_NAME });
      if (target.ok && target.workspaceId) {
        await startWorkspace(deployment, target.workspaceId);
        for (let attempt = 0; attempt < 80; attempt++) {
          await sleep(3000);
          if (target.appUrl && (await isAppReady(deployment, target.appUrl))) break;
        }
      }
    } catch (error) {
      console.warn('[dsh] start workspace failed:', (error as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** QuickPick over the workspace apps; persists dshWeb.coder.appSlug. */
  async selectCoderApp(): Promise<void> {
    const deployment = readCoderDeployment();
    if (!deployment.url || !deployment.token) {
      void vscode.window.showWarningMessage('Coder is not configured (set dshWeb.coder.url / log in).');
      return;
    }
    const target = await resolveTarget(deployment, coderSettings(), { envWorkspace: process.env.CODER_WORKSPACE_NAME });
    if (!target.ok) {
      void vscode.window.showWarningMessage(`Coder: ${target.error}`);
      return;
    }
    if (!target.buildId) {
      void vscode.window.showWarningMessage(`Workspace "${target.workspace}" is ${target.status}; start it to list its apps.`);
      return;
    }
    const apps = await listCoderApps(deployment, target.buildId);
    if (apps.length === 0) {
      void vscode.window.showWarningMessage('No apps found on the workspace.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      apps.map((app) => ({ label: app.slug, description: app.displayName ?? app.url ?? '' })),
      { title: 'Select Coder app', placeHolder: 'App slug' },
    );
    if (!picked) return;
    await dshConfig().update('coder.appSlug', picked.label, vscode.ConfigurationTarget.Global);
    await this.render();
  }

  private mode(): Mode {
    const value = dshConfig().get<string>('mode', 'auto');
    if (value === 'coder' || value === 'local') return value;
    const deployment = readCoderDeployment();
    return deployment.url && deployment.token ? 'coder' : 'local';
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    if (!message || !message.type) return;
    if (message.type === 'setToken' && message.url) {
      await this.setLaunchToken(message.url);
    } else if (message.type === 'coderStart') {
      this.autoStarted = true;
      await this.startCoder();
      await this.render();
    } else if (message.type === 'coderSelectApp') {
      await this.selectCoderApp();
    } else if (message.type === 'coderLogin') {
      void vscode.commands.executeCommand('dshWeb.coderLogin');
    } else if (message.type === 'retry' || message.type === 'reload') {
      await this.render();
    }
  }

  private localProfile(): string {
    return dshConfig().get<string>('profile', 'web');
  }

  private localUrl(): string {
    return stripTrailingSlash(dshConfig().get<string>('url', 'http://127.0.0.1:3080'));
  }

  private async ensureCoderProxy(target: CoderTarget): Promise<ProxyChild> {
    const key = [target.appSlug, target.deployment.url, target.owner, target.workspace].join('|').toLowerCase();
    if (this.coderProxy && this.coderProxy.key === key) return this.coderProxy;
    this.coderProxy?.dispose();
    this.coderProxy = undefined;

    // Stable per-target port so the webview origin survives window reloads.
    const stateKey = 'dshWeb.coderPort.' + key;
    const port = await choosePort({
      saved: this.context.globalState.get<number>(stateKey, 0),
      seed: key,
      base: 40000,
      span: 2000,
      cap: 42000,
    });
    if (port) await this.context.globalState.update(stateKey, port);

    const child = await startCoderProxyChild(target.appUrl, target.deployment.token, target.appHost, port, {
      sessionId: dshConfig().get<string>('sessionId', ''),
    });
    const proxy = Object.assign(child, { key }) as CoderProxy;
    this.coderProxy = proxy;
    return proxy;
  }

  private async coderHtml(): Promise<string> {
    const deployment = readCoderDeployment();
    if (!deployment.url || !deployment.token) {
      return dshMessage(
        'Coder is not configured',
        'No Coder deployment URL/session found. Log in, or set <code>dshWeb.mode</code> to <code>local</code>.',
        [
          { act: 'coderLogin', label: 'Coder Login' },
          { act: 'retry', label: 'Retry' },
        ],
      );
    }

    let target;
    try {
      target = await resolveTarget(deployment, coderSettings(), { envWorkspace: process.env.CODER_WORKSPACE_NAME });
    } catch (error) {
      return dshMessage('Coder API unreachable', `<code>${deployment.url}</code><br/>${(error as Error).message}`, [
        { act: 'coderLogin', label: 'Coder Login' },
        { act: 'retry', label: 'Retry' },
      ]);
    }

    if (!target.ok) {
      switch (target.error) {
        case 'expired':
        case 'no-token':
          return dshMessage('Coder session expired', 'Refresh it with <code>Coder Login</code>.', [
            { act: 'coderLogin', label: 'Coder Login' },
            { act: 'retry', label: 'Retry' },
          ]);
        case 'ambiguous':
          return dshMessage(
            'Several Coder workspaces',
            `Set <code>dshWeb.coder.workspace</code> to one of: <code>${(target.names ?? []).join('</code>, <code>')}</code>`,
            [{ act: 'retry', label: 'Retry' }],
          );
        case 'no-workspace':
          return dshMessage(
            'Coder workspace not found',
            `owner <b>${target.owner ?? '?'}</b>${target.workspace ? `, workspace <b>${target.workspace}</b>` : ''}. Set <code>dshWeb.coder.workspace</code>.`,
            [{ act: 'retry', label: 'Retry' }],
          );
        case 'no-url':
        case 'no-domain':
          return dshMessage('Coder is not configured', `(${target.error})`, [{ act: 'retry', label: 'Retry' }]);
        default:
          return dshMessage('Coder error', `${target.error}${target.status ? ` (${target.status})` : ''}`, [
            { act: 'retry', label: 'Retry' },
          ]);
      }
    }

    if (!target.appSlug) {
      if (target.status !== 'running') return this.workspaceNotRunningMessage(target);
      const selectApp = { act: 'coderSelectApp', label: 'Select app' };
      if (target.candidates && target.candidates.length > 0) {
        return dshMessage(
          'Select a Coder app',
          `Several apps are available: <code>${target.candidates.join('</code>, <code>')}</code>.`,
          [selectApp, { act: 'retry', label: 'Retry' }],
        );
      }
      return dshMessage(
        'No Coder app found',
        `Workspace <b>${target.workspace}</b> exposes no apps. Set <code>dshWeb.coder.appSlug</code>.`,
        [selectApp, { act: 'retry', label: 'Retry' }],
      );
    }

    if (target.status !== 'running') return this.workspaceNotRunningMessage(target);
    this.autoStarted = false;

    let proxy: ProxyChild;
    try {
      proxy = await this.ensureCoderProxy(target);
    } catch (error) {
      return dshMessage('Could not start the Coder proxy', (error as Error).message, [{ act: 'retry', label: 'Retry' }]);
    }
    return dshFrame(proxy.url + '/');
  }

  private workspaceNotRunningMessage(target: CoderTarget): string {
    if (dshConfig().get<boolean>('coder.autoStartWorkspace', false) && !this.busy && !this.autoStarted) {
      this.autoStarted = true;
      void this.startCoder().then(() => void this.render());
    }
    const where = target.appHost ? ` on <code>${target.appHost}</code>` : '';
    return dshMessage(
      `Workspace "${target.workspace}" is ${target.status}`,
      `App <code>${target.appSlug || '—'}</code>${where}.`,
      [
        { act: 'coderStart', label: this.busy ? 'Starting…' : 'Start workspace' },
        { act: 'retry', label: 'Retry' },
      ],
    );
  }

  private async localHtml(): Promise<string> {
    const url = this.localUrl();
    const profile = this.localProfile();
    let status = await dshHealth(url);
    if (status === 'down' && dshConfig().get<boolean>('autoStart', true)) {
      status = await ensureDshLocal(url, profile, this.context);
    }
    const tokenUrl = this.context.globalState.get<string>('dshWeb.tokenUrl.' + profile);

    if (status === 'down') {
      return dshMessage(
        'DSH web GUI is unreachable',
        `<code>${url}</code><br/>Start it with <code>dsh --profile ${profile}</code> or enable autoStart.`,
        [{ act: 'retry', label: 'Retry' }],
      );
    }
    // A VS Code webview is a third-party context for 127.0.0.1, so DSH's
    // SameSite=Strict cookie cannot be used directly in the iframe. The local
    // proxy owns the cookie and injects it server-side, exactly like the Coder
    // proxy does for workspace apps.
    let proxy: ProxyChild;
    try {
      proxy = await this.ensureLocalProxy(url, tokenUrl ?? '', profile);
    } catch (error) {
      return dshMessage('Could not start the DSH proxy', (error as Error).message, [{ act: 'retry', label: 'Retry' }]);
    }
    if (!(await this.waitForDshAuth(proxy.url))) return dshTokenPrompt(url);
    return dshFrame(proxy.url + '/');
  }

  private async ensureLocalProxy(url: string, tokenUrl: string, profile: string): Promise<ProxyChild> {
    const key = [url, tokenUrl, profile].join('|');
    if (this.localProxy && this.localProxyKey === key) return this.localProxy;
    this.disposeLocalProxy();

    const stateKey = 'dshWeb.localPort.' + profile;
    const port = await choosePort({
      saved: this.context.globalState.get<number>(stateKey, 0),
      seed: 'dsh-local|' + profile + '|' + url,
      base: 39000,
      span: 1000,
      cap: 40000,
    });
    if (port) await this.context.globalState.update(stateKey, port);

    fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
    const cookieFile = path.join(
      this.context.globalStorageUri.fsPath,
      'dsh-local-cookie-' + encodeURIComponent(profile) + '.txt',
    );
    const proxy = await startCoderProxyChild(url, '', new URL(url).host, port, {
      launchUrl: tokenUrl,
      cookieFile,
      sessionId: dshConfig().get<string>('sessionId', ''),
    });
    this.localProxy = proxy;
    this.localProxyKey = key;
    return proxy;
  }

  private async waitForDshAuth(proxyUrl: string): Promise<boolean> {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const response = await fetch(proxyUrl + '/__dsh/status', { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          const body = (await response.json()) as { auth?: boolean };
          if (body.auth) return true;
          if (attempt >= 3) return false;
        }
      } catch {
        // proxy still starting
      }
      await sleep(400);
    }
    return false;
  }
}
