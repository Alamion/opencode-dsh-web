// Plain-Node proxy in front of a Coder workspace app (a DSH web UI),
// run as a child process (ELECTRON_RUN_AS_NODE) so VS Code's proxy resolver
// cannot intercept it and so the webview - a third-party context for the app
// origin - does not need any cookie of its own.
//
// Two auth layers are settled here, server-side:
//   * Coder: the Coder-Session-Token header is added to every upstream request.
//   * DSH:   on the first request the proxy reads studio-proxy's launch page,
//            performs the `?token=` exchange itself, keeps the resulting
//            dsh-auth cookie and attaches it to every request. If DSH restarts
//            and refuses the cookie, one exchange is retried.
// Host and Origin are forced to the app host (DSH binds its cookie to it and
// Coder routes subdomain apps by Host).
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { buildCookieHeader, captureCookies, createCookieState, isHopByHop } from '../core/cookies';
import { parseLaunchToken } from '../core/coder';

const target = process.env.CODER_TARGET;
const token = process.env.CODER_TOKEN || '';
const appHost = process.env.CODER_APP_HOST || '';
const preferredPort = parseInt(process.env.CODER_PORT || '0', 10) || 0;
const launchUrl = process.env.DSH_LAUNCH_URL || '';
const cookieFile = process.env.DSH_COOKIE_FILE || '';
const sessionId = process.env.DSH_SESSION_ID || '';
const ocPassword = process.env.OC_PASSWORD || '';

if (!target) {
  process.stderr.write('CODER_TARGET is not set\n');
  process.exit(1);
}

const parsed = new URL(target);
const upstreamHost = parsed.hostname;
const upstreamPort = parsed.port ? Number(parsed.port) : 80;
const hostHeader = appHost || parsed.host;

const state = createCookieState();
let exchanging: Promise<boolean> | null = null;

function readCookieFile(): void {
  if (!cookieFile) return;
  try {
    const value = fs.readFileSync(cookieFile, 'utf8').trim();
    if (value.startsWith('dsh-auth-')) state.dsh = value;
  } catch {
    // no saved cookie yet
  }
}

function saveCookieFile(): void {
  if (!cookieFile || !state.dsh) return;
  try {
    fs.mkdirSync(path.dirname(cookieFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cookieFile, state.dsh, { mode: 0o600 });
  } catch {
    // the cookie still works for this proxy lifetime
  }
}

readCookieFile();

function outHeaders(incoming: http.IncomingHttpHeaders, withCookie: boolean): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase();
    if (isHopByHop(lower) || lower === 'host' || lower === 'origin' || lower === 'referer' || lower === 'accept-encoding') continue;
    headers[key] = value;
  }
  headers.host = hostHeader;
  headers.origin = 'http://' + hostHeader;
  if (incoming.referer) {
    try {
      const referer = new URL(incoming.referer);
      referer.protocol = 'http:';
      referer.host = hostHeader;
      headers.referer = referer.href;
    } catch {
      // ignore malformed referer
    }
  }
  if (token) headers['Coder-Session-Token'] = token;
  if (ocPassword && !headers.authorization) {
    headers.authorization = 'Basic ' + Buffer.from('opencode:' + ocPassword).toString('base64');
  }
  if (withCookie) {
    const cookie = buildCookieHeader(typeof incoming.cookie === 'string' ? incoming.cookie : undefined, state);
    if (cookie) headers.cookie = cookie;
  }
  return headers;
}

function upRequest(method: string, path: string, headers: http.OutgoingHttpHeaders, body?: Buffer): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: upstreamHost, port: upstreamPort, method, path, headers }, (response) => {
      captureCookies(response.headers['set-cookie'], state);
      resolve(response);
    });
    request.on('error', reject);
    if (body && body.length) request.end(body);
    else request.end();
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// Defensive: HTML should be uncompressed (accept-encoding is dropped), but
// decode anyway so a compressed body is never mistaken for text.
function decodeBody(body: Buffer, encoding: string): Buffer {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(body);
    if (encoding === 'deflate') return zlib.inflateSync(body);
    if (encoding === 'br') return zlib.brotliDecompressSync(body);
  } catch {
    // fall through to the raw body
  }
  return body;
}

/** Read the launch page (no dsh cookie) and exchange its token for the cookie. */
function exchange(force = false): Promise<boolean> {
  if (state.dsh && !force) return Promise.resolve(true);
  if (exchanging) return exchanging;
  if (force) state.dsh = '';
  exchanging = (async () => {
    if (launchUrl) {
      const launch = new URL(launchUrl);
      const response = await upRequest(
        'GET',
        launch.pathname + launch.search,
        outHeaders({ host: hostHeader, accept: '*/*' }, false),
      );
      response.resume();
      await new Promise<void>((resolve) => response.on('end', () => resolve()));
      saveCookieFile();
      return Boolean(state.dsh);
    }
    const probe = await upRequest('GET', '/', outHeaders({ host: hostHeader, accept: 'text/html' }, false));
    const launchToken = parseLaunchToken((await readAll(probe)).toString('utf8'));
    if (!launchToken) return false;
    const response = await upRequest('GET', '/?token=' + encodeURIComponent(launchToken), outHeaders({ host: hostHeader, accept: '*/*' }, false));
    response.resume();
    await new Promise<void>((resolve) => response.on('end', () => resolve()));
    saveCookieFile();
    return Boolean(state.dsh);
  })()
    .catch(() => false)
    .finally(() => {
      exchanging = null;
    });
  return exchanging;
}

async function sendUpstream(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, retried: boolean): Promise<void> {
  if (!state.dsh && launchUrl) {
    try {
      await exchange();
    } catch {
      // fall through; the auth page will explain the failure
    }
  }
  let upstream: http.IncomingMessage;
  try {
    upstream = await upRequest(req.method ?? 'GET', req.url ?? '/', outHeaders(req.headers, true), body);
  } catch (error) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('coder app unreachable: ' + (error as Error).message);
    return;
  }

  if (upstream.statusCode === 401 && !retried) {
    upstream.resume();
    await new Promise<void>((resolve) => upstream.on('end', () => resolve()));
    if (await exchange(true)) {
      await sendUpstream(req, res, body, true);
      return;
    }
    if (!res.headersSent) res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh refused the launch token');
    return;
  }

  const contentType = String(upstream.headers['content-type'] ?? '');
  if (contentType.includes('text/html')) {
    const html = decodeBody(await readAll(upstream), String(upstream.headers['content-encoding'] ?? '')).toString('utf8');
    if (parseLaunchToken(html)) {
      if (!retried && (await exchange())) {
        await sendUpstream(req, res, body, true);
        return;
      }
      // Never hand the launch page to the browser: with no working cookie it
      // would loop (and rate-limit Coder). Fail loudly instead.
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('DSH launch token could not be exchanged; see the Coder proxy log.');
      return;
    }
    let injected = html;
    if (sessionId) {
      const value = JSON.stringify(sessionId).replace(/</g, '\\u003c');
      const script = `<script>try{localStorage.setItem("dsh.sessions.current",JSON.stringify({sessionId:${value}}))}catch(e){}</script>`;
      injected = injected.replace(/<\/head>/i, script + '</head>');
    }
    const out = Buffer.from(injected, 'utf8');
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (!isHopByHop(key)) headers[key] = value;
    }
    headers['content-length'] = String(out.length);
    delete headers.etag;
    delete headers['content-encoding'];
    res.writeHead(upstream.statusCode ?? 200, upstream.statusMessage, headers);
    res.end(out);
    return;
  }

  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (!isHopByHop(key)) headers[key] = value;
  }
  res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, headers);
  upstream.pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url === '/__dsh/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ auth: Boolean(state.dsh) }));
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    void sendUpstream(req, res, Buffer.concat(chunks), false).catch(() => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('coder app proxy error');
    });
  });
});

server.on('upgrade', (req, socket, head) => {
  void (async () => {
    if (!state.dsh) {
      try {
        await exchange();
      } catch {
        // continue; the upgrade will fail if the cookie is required
      }
    }
    const headers = outHeaders(req.headers, true);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = (): void => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
  })();
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE' && preferredPort) {
    process.stderr.write('coder proxy port busy, falling back to an ephemeral one\n');
    server.listen(0, '127.0.0.1', report);
    return;
  }
  process.stderr.write('coder proxy listen error: ' + error.message + '\n');
  process.exit(1);
});

function report(): void {
  process.stdout.write('PORT=' + (server.address() as net.AddressInfo).port + '\n');
}

server.listen(preferredPort, '127.0.0.1', report);
if (launchUrl) void exchange();

process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
