// Plain-Node proxy in front of the OpenCode server, run as a child process
// (ELECTRON_RUN_AS_NODE) so VS Code's proxy resolver (http.proxySupport=override)
// cannot intercept http.request and hang up on the localhost target. It injects
// the OpenCode Basic auth on every request, including WebSocket upgrades, and
// synchronises web-UI appearance across proxy origins when OC_APPEARANCE_FILE
// is set.
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as httpProxy from 'http-proxy';
import {
  addCspHash,
  APPEARANCE_ENDPOINT,
  AppearanceProfile,
  DISABLED_SERVICE_WORKER,
  injectAppearanceSync,
  mergeAppearanceProfile,
  normalizeAppearanceProfile,
  parseAppearanceProfile,
} from '../core/appearance';

const target = process.env.OC_TARGET;
const password = process.env.OC_PASSWORD || '';
const preferredPort = parseInt(process.env.OC_PORT || '0', 10) || 0;
const appearanceFile = process.env.OC_APPEARANCE_FILE || '';
const syncAppearance = appearanceFile !== '';
const syncPreferences = process.env.OC_SYNC_PREFERENCES === '1';
const eventsPath = APPEARANCE_ENDPOINT + '/events';
const appearanceClients = new Set<http.ServerResponse>();
let lastBroadcast = '';
let broadcastTimer: NodeJS.Timeout | undefined;

if (!target) {
  process.stderr.write('OC_TARGET is not set\n');
  process.exit(1);
}

const auth = password ? 'Basic ' + Buffer.from('opencode:' + password).toString('base64') : undefined;

const proxy = httpProxy.createProxyServer({ target, ws: true, xfwd: true, selfHandleResponse: true });

proxy.on('proxyReq', (proxyReq: any, req: http.IncomingMessage) => {
  if (auth && !proxyReq.getHeader('authorization')) proxyReq.setHeader('Authorization', auth);
  // Keep the document response readable so the appearance script can be
  // injected without a decompression step.
  if (syncAppearance && isDocumentRequest(req)) proxyReq.setHeader('Accept-Encoding', 'identity');
});
proxy.on('proxyReqWs', (proxyReq: any) => {
  if (auth) proxyReq.setHeader('Authorization', auth);
});
proxy.on('proxyRes', (proxyRes: http.IncomingMessage, req: http.IncomingMessage, res: http.ServerResponse) => {
  const headers = { ...proxyRes.headers } as http.OutgoingHttpHeaders;
  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  const contentEncoding = String(headers['content-encoding'] ?? '').toLowerCase();
  const canInject =
    syncAppearance &&
    req.method === 'GET' &&
    contentType.includes('text/html') &&
    (contentEncoding === '' || contentEncoding === 'identity');

  if (!canInject) {
    res.writeHead(proxyRes.statusCode ?? 502, headers);
    proxyRes.pipe(res);
    return;
  }

  const chunks: Buffer[] = [];
  proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
  proxyRes.on('end', () => {
    try {
      const source = Buffer.concat(chunks).toString('utf8');
      const injected = injectAppearanceSync(source, readAppearanceProfile(), { syncPreferences });
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      headers['content-length'] = String(Buffer.byteLength(injected.html));
      headers['content-security-policy'] = addCspHashToStrings(headers['content-security-policy'], injected.hash);
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      res.end(injected.html);
    } catch (error) {
      process.stderr.write('appearance injection failed: ' + (error as Error).message + '\n');
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      res.end(Buffer.concat(chunks));
    }
  });
  proxyRes.on('error', (error: Error) => {
    process.stderr.write('proxy response error: ' + error.message + '\n');
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
});
proxy.on('error', (error: Error, _req: unknown, res: unknown) => {
  process.stderr.write('proxy error: ' + (error && error.message) + '\n');
  const response = res as http.ServerResponse | undefined;
  if (response && response.writeHead) {
    response.writeHead(502);
    response.end('proxy error: ' + error.message);
  }
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (syncAppearance && url.pathname === APPEARANCE_ENDPOINT) {
    handleAppearance(req, res);
    return;
  }
  if (syncAppearance && url.pathname === eventsPath) {
    handleAppearanceEvents(req, res);
    return;
  }
  // The real Workbox worker precaches index.html and would hide the injected
  // profile. This worker removes itself so navigation always reaches the proxy.
  if (syncAppearance && url.pathname === '/sw.js') {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.end(DISABLED_SERVICE_WORKER);
    return;
  }
  proxy.web(req, res);
});
server.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head));
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE' && preferredPort) {
    process.stderr.write('openCode proxy port busy, falling back to an ephemeral one\n');
    server.listen(0, '127.0.0.1', report);
    return;
  }
  process.stderr.write('opencode proxy listen error: ' + error.message + '\n');
  process.exit(1);
});

function isDocumentRequest(req: http.IncomingMessage): boolean {
  const accept = String(req.headers.accept ?? '').toLowerCase();
  const dest = String(req.headers['sec-fetch-dest'] ?? '').toLowerCase();
  const url = req.url ?? '/';
  return req.method === 'GET' && (accept.includes('text/html') || dest === 'document' || url === '/' || url.startsWith('/?'));
}

function readAppearanceProfile(): AppearanceProfile {
  try {
    return parseAppearanceProfile(fs.readFileSync(appearanceFile, 'utf8'));
  } catch {
    return normalizeAppearanceProfile(undefined);
  }
}

function writeAppearanceProfile(profile: AppearanceProfile): void {
  const directory = path.dirname(appearanceFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${appearanceFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(profile), { mode: 0o600 });
  fs.renameSync(temporary, appearanceFile);
}

function handleAppearance(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(readAppearanceProfile()));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' });
    res.end();
    return;
  }
  // A custom header cannot be set by a cross-origin no-cors fetch, so a random
  // web page cannot overwrite the shared appearance profile via localhost.
  if (req.headers['x-oc-appearance'] !== '1') {
    res.writeHead(403);
    res.end();
    return;
  }

  const limit = 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  let rejected = false;
  req.on('data', (chunk: Buffer) => {
    if (rejected) return;
    size += chunk.length;
    if (size > limit) {
      rejected = true;
      res.writeHead(413);
      res.end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (rejected) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400);
      res.end('invalid appearance JSON');
      return;
    }
    try {
      const incoming = normalizeAppearanceProfile(parsed);
      const current = readAppearanceProfile();
      const changed =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { changed?: unknown }).changed)
          ? (parsed as { changed: unknown[] }).changed.filter((entry): entry is string => typeof entry === 'string')
          : ['all'];
      const profile = mergeAppearanceProfile(current, incoming, changed, syncPreferences);
      writeAppearanceProfile(profile);
      broadcastAppearance(profile, String(req.headers['x-oc-appearance-source'] ?? ''));
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    } catch (error) {
      process.stderr.write('appearance write failed: ' + (error as Error).message + '\n');
      res.writeHead(500);
      res.end('appearance write failed');
    }
  });
}

function handleAppearanceEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  res.write(`data: ${JSON.stringify({ source: '', profile: readAppearanceProfile() })}\n\n`);
  appearanceClients.add(res);
  req.on('close', () => appearanceClients.delete(res));
}

function broadcastAppearance(profile: AppearanceProfile, source: string): void {
  const body = JSON.stringify(profile);
  if (body === lastBroadcast) return;
  lastBroadcast = body;
  const payload = `data: ${JSON.stringify({ source, profile })}\n\n`;
  for (const client of appearanceClients) {
    try {
      client.write(payload);
    } catch {
      appearanceClients.delete(client);
    }
  }
}

function scheduleAppearanceBroadcast(): void {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => broadcastAppearance(readAppearanceProfile(), ''), 100);
}

function startAppearanceWatcher(): void {
  if (!syncAppearance) return;
  lastBroadcast = JSON.stringify(readAppearanceProfile());
  try {
    const directory = path.dirname(appearanceFile);
    const basename = path.basename(appearanceFile);
    fs.watch(directory, (_event, filename) => {
      if (filename && filename !== basename) return;
      scheduleAppearanceBroadcast();
    });
  } catch (error) {
    process.stderr.write('appearance watcher failed: ' + (error as Error).message + '\n');
  }
  setInterval(() => {
    for (const client of appearanceClients) {
      try {
        client.write(': ping\n\n');
      } catch {
        appearanceClients.delete(client);
      }
    }
  }, 25_000).unref();
}

function addCspHashToStrings(value: string | string[] | number | undefined, hash: string): string | undefined {
  if (Array.isArray(value)) return value.map((entry) => addCspHash(String(entry), hash)).join(', ');
  if (value === undefined) return undefined;
  return addCspHash(String(value), hash);
}

function report(): void {
  process.stdout.write('PORT=' + (server.address() as AddressInfo).port + '\n');
}

server.timeout = 0;
server.listen(preferredPort, '127.0.0.1', report);
startAppearanceWatcher();

process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
