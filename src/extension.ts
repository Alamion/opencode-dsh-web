import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createResetProfile } from './core/appearance';
import { CoderTargetError, resolveTarget } from './core/coder';
import { choosePort } from './core/net';
import { basicAuth, chooseOpenCodeMode } from './core/opencode';
import { sleep, stripTrailingSlash } from './core/util';
import { DSH_VIEW, DshProvider } from './providers/dsh';
import { OPENCODE_VIEW, OpenCodeProvider } from './providers/opencode';
import { ProxyChild, startCoderProxyChild, startOpenCodeProxyChild, startOpenCodeProxyInProcess } from './providers/proxy';
import { coderCliPath, coderSettings, dshConfig, opencodeConfig, readCoderDeployment, readOpenCodePassword } from './providers/settings';

async function pingServer(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(serverUrl + '/api/info', { signal: AbortSignal.timeout(2000) });
    return response.status === 401 || response.ok;
  } catch {
    return false;
  }
}

async function checkOpenCodeAuth(serverUrl: string, password: string): Promise<boolean> {
  try {
    const response = await fetch(serverUrl + '/api/info', {
      headers: { Authorization: basicAuth(password) },
      signal: AbortSignal.timeout(2500),
    });
    return response.status !== 401;
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

async function startOpenCodeProxy(
  serverUrl: string,
  password: string,
  port: number,
  appearanceFile: string,
  syncPreferences: boolean,
): Promise<ProxyChild> {
  try {
    return await startOpenCodeProxyChild(serverUrl, password, port, appearanceFile, syncPreferences);
  } catch (error) {
    console.warn('[opencode] child proxy failed, using in-process proxy:', (error as Error).message);
    return startOpenCodeProxyInProcess(serverUrl, password);
  }
}

function coderErrorMessage(target: CoderTargetError): string {
  switch (target.error) {
    case 'expired':
    case 'no-token':
      return 'Coder session expired or missing. Run "DSH Web: Coder Login", then retry.';
    case 'no-url':
      return 'Coder is not configured. Set dshWeb.coder.url or log in with the coder CLI.';
    case 'ambiguous':
      return `Several Coder workspaces: ${(target.names ?? []).join(', ')}. Set dshWeb.coder.workspace.`;
    case 'no-workspace':
      return `Coder workspace not found (owner ${target.owner ?? '?'}, workspace ${target.workspace ?? '?'}).`;
    case 'no-domain':
      return 'Coder app domain is empty. Set dshWeb.coder.appDomain.';
    default:
      return `Coder error: ${target.error}${target.status ? ` (${target.status})` : ''}.`;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = (vscode.workspace.workspaceFolders ?? [])[0];
  const appearanceFile = prepareAppearanceFile(context);
  const syncPreferences = appearanceFile !== '' && opencodeConfig().get<boolean>('syncPreferences', false);
  const coderMode = chooseOpenCodeMode(opencodeConfig().get<string>('mode', 'local'), dshConfig().get<string>('coder.workspace', '')) === 'coder';
  const coderDirectory = opencodeConfig().get<string>('coder.directory', '');

  let serverUrl = stripTrailingSlash(opencodeConfig().get<string>('serverUrl', 'http://127.0.0.1:4096'));
  let password = readOpenCodePassword();
  let proxy: ProxyChild | undefined;
  let coderProxy: ProxyChild | undefined;
  let coderKey = '';
  let proxyServerUrl = '';
  let proxyPassword = '';
  let openCode: OpenCodeProvider;

  const connectLocal = async (settings?: { serverUrl?: string; password?: string }): Promise<boolean> => {
    if (settings?.serverUrl) {
      await opencodeConfig().update('serverUrl', stripTrailingSlash(settings.serverUrl), vscode.ConfigurationTarget.Global);
    }
    if (settings?.password) {
      await opencodeConfig().update('password', settings.password, vscode.ConfigurationTarget.Global);
    }
    serverUrl = stripTrailingSlash(opencodeConfig().get<string>('serverUrl', 'http://127.0.0.1:4096'));
    if (!(await ensureServer(serverUrl))) {
      password = readOpenCodePassword();
      openCode.setConnection(
        '',
        serverUrl,
        password,
        `OpenCode server at ${serverUrl} is unreachable. Start it with "opencode service start", then retry.`,
        '',
      );
      return false;
    }
    // `opencode service start` may have just created service.json.
    password = readOpenCodePassword();
    if (!(await checkOpenCodeAuth(serverUrl, password))) {
      openCode.setConnection(
        '',
        serverUrl,
        password,
        'The OpenCode server rejected the password. Check opencodeWeb.password or ~/.config/opencode/service.json.',
        '',
      );
      return false;
    }
    if (proxy && proxyServerUrl === serverUrl && proxyPassword === password) {
      openCode.setConnection(proxy.url, serverUrl, password, '', '');
      return true;
    }
    proxy?.dispose();
    proxy = undefined;
    const port = await pickOpenCodePort(context, folder);
    proxy = await startOpenCodeProxy(serverUrl, password, port, appearanceFile, syncPreferences);
    proxyServerUrl = serverUrl;
    proxyPassword = password;
    openCode.setConnection(proxy.url, serverUrl, password, '', '');
    return true;
  };

  const connectCoder = async (): Promise<boolean> => {
    const deployment = readCoderDeployment();
    const base = coderSettings();
    const appSlug = opencodeConfig().get<string>('coder.appSlug', 'opencode') || base.appSlug;
    const directory = opencodeConfig().get<string>('coder.directory', '');
    const coderPassword = opencodeConfig().get<string>('coder.password', '') || readOpenCodePassword();

    let target;
    try {
      target = await resolveTarget(deployment, { ...base, appSlug }, { envWorkspace: process.env.CODER_WORKSPACE_NAME });
    } catch (error) {
      openCode.setConnection('', '', '', `Coder API unreachable: ${(error as Error).message}`, directory);
      return false;
    }
    if (!target.ok) {
      openCode.setConnection('', '', '', coderErrorMessage(target), directory);
      return false;
    }
    if (target.status !== 'running') {
      openCode.setConnection(
        '',
        '',
        '',
        `Coder workspace "${target.workspace}" is ${target.status}. Start it (DSH Web: Start Coder Workspace) and retry.`,
        directory,
      );
      return false;
    }
    if (!target.appSlug) {
      openCode.setConnection(
        '',
        '',
        '',
        `Workspace "${target.workspace}" has no OpenCode app. Set opencodeWeb.coder.appSlug.`,
        directory,
      );
      return false;
    }

    const key = [target.appUrl, target.appHost, target.deployment.token, coderPassword].join('|');
    if (proxy && coderProxy && coderKey === key) {
      openCode.setConnection(proxy.url, proxy.url, coderPassword, '', directory);
      return true;
    }

    coderProxy?.dispose();
    coderProxy = undefined;
    proxy?.dispose();
    proxy = undefined;

    // Coder proxy owns the Coder session token and app host; the ordinary
    // OpenCode proxy in front of it owns Basic auth and appearance sync.
    coderProxy = await startCoderProxyChild(target.appUrl, target.deployment.token, target.appHost, 0);
    const port = await pickOpenCodePort(context, folder);
    proxy = await startOpenCodeProxy(coderProxy.url, coderPassword, port, appearanceFile, syncPreferences);
    coderKey = key;

    if (!(await checkOpenCodeAuth(proxy.url, coderPassword))) {
      openCode.setConnection(
        '',
        proxy.url,
        coderPassword,
        'OpenCode in the Coder workspace rejected the password. Set opencodeWeb.coder.password.',
        directory,
      );
      return false;
    }
    openCode.setConnection(proxy.url, proxy.url, coderPassword, '', directory);
    return true;
  };

  const connect = async (settings?: { serverUrl?: string; password?: string }): Promise<boolean> =>
    coderMode ? connectCoder() : connectLocal(settings);

  openCode = new OpenCodeProvider(context, '', coderMode ? '' : serverUrl, password, connect, coderMode, coderDirectory);
  await connect();

  const dsh = new DshProvider(context);
  context.subscriptions.push({ dispose: () => proxy?.dispose() }, { dispose: () => coderProxy?.dispose() });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OPENCODE_VIEW, openCode, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(DSH_VIEW, dsh, { webviewOptions: { retainContextWhenHidden: true } }),
    { dispose: () => dsh.dispose() },

    vscode.commands.registerCommand('opencodeWeb.open', () => vscode.commands.executeCommand(`${OPENCODE_VIEW}.focus`)),
    vscode.commands.registerCommand('opencodeWeb.reload', async () => {
      if (!proxy) await connect();
      await openCode.render();
    }),
    vscode.commands.registerCommand('opencodeWeb.openBrowser', () =>
      vscode.env.openExternal(vscode.Uri.parse((proxy?.url ?? serverUrl) + '/')),
    ),
    vscode.commands.registerCommand('opencodeWeb.newSession', async () => {
      if (!openCode.isOpen) await vscode.commands.executeCommand(`${OPENCODE_VIEW}.focus`);
      if (!proxy && !(await connect())) return;
      await openCode.createSession();
    }),
    vscode.commands.registerCommand('opencodeWeb.resetAppearance', async () => {
      if (!appearanceFile) {
        vscode.window.showInformationMessage('OpenCode appearance sync is disabled (opencodeWeb.syncAppearance).');
        return;
      }
      try {
        writeResetProfile(appearanceFile);
        await openCode.render();
        vscode.window.showInformationMessage('Shared OpenCode appearance has been reset.');
      } catch (error) {
        vscode.window.showErrorMessage(`Could not reset OpenCode appearance: ${(error as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('dshWeb.open', () => vscode.commands.executeCommand(`${DSH_VIEW}.focus`)),
    vscode.commands.registerCommand('dshWeb.reload', () => dsh.render()),
    vscode.commands.registerCommand('dshWeb.openBrowser', () => vscode.env.openExternal(vscode.Uri.parse(dsh.externalUrl() + '/'))),
    vscode.commands.registerCommand('dshWeb.coderStart', async () => {
      await dsh.startCoder();
      await dsh.render();
    }),
    vscode.commands.registerCommand('dshWeb.coderSelectApp', () => dsh.selectCoderApp()),
    vscode.window.registerUriHandler({
      handleUri(uri) {
        if (uri.path === '/open-opencode') return vscode.commands.executeCommand(`${OPENCODE_VIEW}.focus`);
        if (uri.path === '/open-dsh') return vscode.commands.executeCommand(`${DSH_VIEW}.focus`);
        return undefined;
      },
    }),
    vscode.commands.registerCommand('dshWeb.setToken', async () => {
      const value = await vscode.window.showInputBox({
        title: 'DSH launch URL',
        prompt: 'Paste the line printed by dsh: dsh web: <url>',
        ignoreFocusOut: true,
      });
      if (value) await dsh.setLaunchToken(value);
    }),
    vscode.commands.registerCommand('dshWeb.coderLogin', () => {
      const deployment = readCoderDeployment();
      const cli = coderCliPath();
      const terminal = vscode.window.createTerminal('Coder Login');
      terminal.show();
      terminal.sendText(deployment.url ? `"${cli}" login ${deployment.url}` : `"${cli}" login`);
    }),
  );

  const openOpenCode = opencodeConfig().get<boolean>('openOnStartup', false);
  const openDsh = dshConfig().get<boolean>('openOnStartup', false);
  if (openOpenCode || openDsh) {
    setTimeout(() => {
      void vscode.commands.executeCommand(`${openOpenCode ? OPENCODE_VIEW : DSH_VIEW}.focus`);
    }, 2000);
  }
}

function writeResetProfile(file: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(createResetProfile()), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function prepareAppearanceFile(context: vscode.ExtensionContext): string {
  if (!opencodeConfig().get<boolean>('syncAppearance', true)) return '';
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    return path.join(context.globalStorageUri.fsPath, 'appearance.json');
  } catch (error) {
    console.warn('[opencode] cannot prepare appearance storage:', (error as Error).message);
    return '';
  }
}

export function deactivate(): void {
  // proxy children are closed through context.subscriptions
}
