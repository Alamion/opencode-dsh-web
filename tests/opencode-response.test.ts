import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { forwardOpenCodeResponse, isDocumentRequest } from '../src/core/opencode-response';
import { DISABLED_SERVICE_WORKER, normalizeAppearanceProfile } from '../src/core/appearance';
import { startOpenCodeProxyInProcess } from '../src/providers/proxy';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
}

describe('OpenCode HTML responses', () => {
  it('recognizes iframe documents without disabling API and asset caching', () => {
    expect(isDocumentRequest({ method: 'GET', url: '/session/one', headers: { 'sec-fetch-dest': 'iframe' } })).toBe(true);
    expect(isDocumentRequest({ method: 'GET', url: '/session/one', headers: { accept: 'text/html' } })).toBe(true);
    expect(isDocumentRequest({ method: 'GET', url: '/assets/app.js', headers: {} })).toBe(false);
    expect(isDocumentRequest({ method: 'GET', url: '/api/session', headers: {} })).toBe(false);
    expect(isDocumentRequest({ method: 'POST', url: '/', headers: {} })).toBe(false);
  });
  it.each([false, true])('installs the bridge with appearance sync=%s and preserves CSP restrictions', async sync => {
    const upstream = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'self'", etag: 'old-page' });
      res.end('<html><head></head><body>OpenCode</body></html>');
    });
    const proxy = await serve((req, res) => {
      http.get(upstream, response => forwardOpenCodeResponse(response, req, res, sync ? { profile: normalizeAppearanceProfile(undefined), syncPreferences: false } : undefined));
    });
    const response = await fetch(proxy);
    const html = await response.text();
    expect(html).toContain('oc-webview-bridge');
    expect(html.includes('oc-appearance-sync')).toBe(sync);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'; script-src 'self' 'sha256-");
    expect(response.headers.get('etag')).toBe(null);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(html));
  });
  it('streams API responses unchanged', async () => {
    const upstream = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); });
    const proxy = await serve((req, res) => { http.get(upstream, response => forwardOpenCodeResponse(response, req, res)); });
    expect(await (await fetch(proxy)).text()).toBe('{"data":[]}');
  });
  it('installs the bridge and bypasses stale HTML caches in the fallback proxy', async () => {
    let received: http.IncomingHttpHeaders = {};
    const upstream = await serve((req, res) => {
      received = req.headers;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head></head><body>OpenCode</body></html>');
    });
    const proxy = await startOpenCodeProxyInProcess(upstream, 'test-password');
    try {
      const response = await fetch(proxy.url, { headers: { accept: 'text/html', 'if-none-match': 'old-page' } });
      expect(await response.text()).toContain('oc-webview-bridge');
      expect(received.authorization).toBe('Basic ' + Buffer.from('opencode:test-password').toString('base64'));
      expect(received['accept-encoding']).toBe('identity');
      expect(received['if-none-match']).toBeUndefined();
      const worker = await fetch(proxy.url + '/sw.js');
      expect(worker.headers.get('content-type')).toContain('javascript');
      expect(await worker.text()).toBe(DISABLED_SERVICE_WORKER);
    } finally {
      proxy.dispose();
    }
  });
});
