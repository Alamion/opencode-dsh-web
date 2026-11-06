import * as cp from 'node:child_process';
import * as vscode from 'vscode';
import { choosePort } from './core/net';
import { sleep, stripTrailingSlash } from './core/util';
import { DSH_VIEW, DshProvider } from './providers/dsh';
import { OPENCODE_VIEW, OpenCodeProvider } from './providers/opencode';
import { ProxyChild, startOpenCodeProxyChild, startOpenCodeProxyInProcess } from './providers/proxy';
import { coderCliPath, opencodeConfig, readCoderDeployment, readOpenCodePassword } from './providers/settings';

async function pingServer(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(serverUrl + '/api/info', { signal: AbortSignal.timeout(2000) });
    return response.status === 401 || response.ok;
  } catch {
    return false;
  }
}

async function ensureServer(serverUrl: string): Promise<boolean> {
  if (await pingServer(serverUrl)) return true;
  if (!opencodeConfig().get<boolean>('autoStart', true)) return false;
  try {
    cp.spawn('opencode', ['service', 'start'], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(750);
    if (await pingServer(serverUrl)) return true;
  }
  return false;
}

/**
 * A stable per-workspace proxy port, so each workspace keeps its own webview
 * origin (and with it the OpenCode UI state: last project, open chats).
 */
async function pickOpenCodePort(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder | undefined): Promise<number> {
  if (!folder) return 0;
  const key = 'opencodeWeb.port.' + folder.uri.fsPath;
  const port = await choosePort({
    saved: context.workspaceState.get<number>(key, 0),
    seed: folder.uri.fsPath,
    base: 43000,
    span: 6000,
    cap: 50000,
  });
  if (port) await context.workspaceState.update(key, port);
  return port;
}

async function startOpenCodeProxy(serverUrl: string, password: string, port: number): Promise<ProxyChild> {
  try {
    return await startOpenCodeProxyChild(serverUrl, password, port);
  } catch (error) {
    console.warn('[opencode] child proxy failed, using in-process proxy:', (error as Error).message);
    return startOpenCodeProxyInProcess(serverUrl, password);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverUrl = stripTrailingSlash(opencodeConfig().get<string>('serverUrl', 'http://127.0.0.1:4096'));
  const password = readOpenCodePassword();

  if (!(await ensureServer(serverUrl))) {
    const choice = await vscode.window.showWarningMessage(
      `OpenCode server at ${serverUrl} is unreachable. Start it with: opencode service start`,
      'Retry',
    );
    if (choice === 'Retry') await activate(context);
    return;
  }

  const folder = (vscode.workspace.workspaceFolders ?? [])[0];
  const port = await pickOpenCodePort(context, folder);
  const proxy = await startOpenCodeProxy(serverUrl, password, port);
  context.subscriptions.push({ dispose: () => proxy.dispose() });

  const openCode = new OpenCodeProvider(context, proxy.url, serverUrl, password);
  const dsh = new DshProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OPENCODE_VIEW, openCode, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(DSH_VIEW, dsh, { webviewOptions: { retainContextWhenHidden: true } }),
    { dispose: () => dsh.dispose() },

    vscode.commands.registerCommand('opencodeWeb.open', () => vscode.commands.executeCommand(`${OPENCODE_VIEW}.focus`)),
    vscode.commands.registerCommand('opencodeWeb.reload', () => openCode.render()),
    vscode.commands.registerCommand('opencodeWeb.openBrowser', () => vscode.env.openExternal(vscode.Uri.parse(proxy.url + '/'))),
    vscode.commands.registerCommand('opencodeWeb.newSession', async () => {
      if (!openCode.isOpen) await vscode.commands.executeCommand(`${OPENCODE_VIEW}.focus`);
      await openCode.createSession();
    }),

    vscode.commands.registerCommand('dshWeb.open', () => vscode.commands.executeCommand(`${DSH_VIEW}.focus`)),
    vscode.commands.registerCommand('dshWeb.reload', () => dsh.render()),
    vscode.commands.registerCommand('dshWeb.openBrowser', () => vscode.env.openExternal(vscode.Uri.parse(dsh.externalUrl() + '/'))),
    vscode.commands.registerCommand('dshWeb.coderStart', async () => {
      await dsh.startCoder();
      await dsh.render();
    }),
    vscode.commands.registerCommand('dshWeb.coderSelectApp', () => dsh.selectCoderApp()),
    vscode.commands.registerCommand('dshWeb.coderLogin', () => {
      const deployment = readCoderDeployment();
      const cli = coderCliPath();
      const terminal = vscode.window.createTerminal('Coder Login');
      terminal.show();
      terminal.sendText(deployment.url ? `"${cli}" login ${deployment.url}` : `"${cli}" login`);
    }),
  );
}

export function deactivate(): void {
  // proxy children are closed through context.subscriptions
}
