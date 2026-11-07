import * as cp from 'node:child_process';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as httpProxy from 'http-proxy';
import { basicAuth } from '../core/opencode';

export interface ProxyChild {
  url: string;
  dispose(): void;
}

/**
 * Spawn a plain-Node proxy child (ELECTRON_RUN_AS_NODE) so http-proxy is not
 * intercepted by VS Code's proxy resolver (http.proxySupport=override routes
 * http.request through the system proxy, which hangs up on localhost).
 */
function spawnProxyChild(script: string, env: NodeJS.ProcessEnv, label: string): Promise<ProxyChild> {
  const childScript = path.join(__dirname, script);
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [childScript], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} child did not report a port in time`));
    }, 5000);
    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const match = buffer.match(/PORT=(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        url: `http://127.0.0.1:${match[1]}`,
        dispose: () => {
          try {
            child.stdin.end();
          } catch {
            /* already closed */
          }
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        },
      });
    });
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.log(`[${label}] ${text}`);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`${label} child exited before reporting a port`));
    });
  });
}

export function startOpenCodeProxyChild(
  serverUrl: string,
  password: string,
  port: number,
  appearanceFile = '',
  syncPreferences = false,
): Promise<ProxyChild> {
  return spawnProxyChild(
    'opencode-proxy.js',
    {
      OC_TARGET: serverUrl,
      OC_PASSWORD: password || '',
      OC_PORT: String(port || 0),
      OC_APPEARANCE_FILE: appearanceFile,
      OC_SYNC_PREFERENCES: syncPreferences ? '1' : '0',
    },
    'opencode-proxy',
  );
}

export interface CoderProxyOptions {
  /** Local DSH launch URL (`dsh web: <url>`). */
  launchUrl?: string;
  /** File where the proxy remembers the DSH auth cookie between runs. */
  cookieFile?: string;
  /** DSH session id to select when the app boots (advanced deep link). */
  sessionId?: string;
}

export function startCoderProxyChild(
  target: string,
  token: string,
  appHost: string,
  port: number,
  options: CoderProxyOptions = {},
): Promise<ProxyChild> {
  return spawnProxyChild(
    'coder-proxy.js',
    {
      CODER_TARGET: target,
      CODER_TOKEN: token || '',
      CODER_APP_HOST: appHost || '',
      CODER_PORT: String(port || 0),
      DSH_LAUNCH_URL: options.launchUrl || '',
      DSH_COOKIE_FILE: options.cookieFile || '',
      DSH_SESSION_ID: options.sessionId || '',
    },
    'coder-proxy',
  );
}

/** Last-resort in-process proxy when the child cannot be spawned at all. */
export function startOpenCodeProxyInProcess(serverUrl: string, password: string): Promise<ProxyChild> {
  const proxy = httpProxy.createProxyServer({ target: serverUrl, ws: true, xfwd: true });
  const auth = basicAuth(password);
  proxy.on('proxyReq', (proxyReq: any) => {
    if (!proxyReq.getHeader('authorization')) proxyReq.setHeader('Authorization', auth);
  });
  proxy.on('proxyReqWs', (proxyReq: any) => proxyReq.setHeader('Authorization', auth));
  proxy.on('error', (error: Error, _req: unknown, res: unknown) => {
    const response = res as http.ServerResponse | undefined;
    if (response && response.writeHead) {
      response.writeHead(502);
      response.end('proxy error: ' + error.message);
    }
  });
  const server = http.createServer((req, res) => proxy.web(req, res));
  server.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${address.port}`, dispose: () => server.close() });
    });
  });
}
