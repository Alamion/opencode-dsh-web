// Plain-Node proxy in front of the OpenCode server, run as a child process
// (ELECTRON_RUN_AS_NODE) so VS Code's proxy resolver (http.proxySupport=override)
// cannot intercept http.request and hang up on the localhost target. It injects
// the OpenCode Basic auth on every request, including WebSocket upgrades.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as httpProxy from 'http-proxy';

const target = process.env.OC_TARGET;
const password = process.env.OC_PASSWORD || '';
const preferredPort = parseInt(process.env.OC_PORT || '0', 10) || 0;

if (!target) {
  process.stderr.write('OC_TARGET is not set\n');
  process.exit(1);
}

const auth = password ? 'Basic ' + Buffer.from('opencode:' + password).toString('base64') : undefined;

const proxy = httpProxy.createProxyServer({ target, ws: true, xfwd: true });

proxy.on('proxyReq', (proxyReq: any) => {
  if (auth && !proxyReq.getHeader('authorization')) proxyReq.setHeader('Authorization', auth);
});
proxy.on('proxyReqWs', (proxyReq: any) => {
  if (auth) proxyReq.setHeader('Authorization', auth);
});
proxy.on('error', (error: Error, _req: unknown, res: unknown) => {
  process.stderr.write('proxy error: ' + (error && error.message) + '\n');
  const response = res as http.ServerResponse | undefined;
  if (response && response.writeHead) {
    response.writeHead(502);
    response.end('proxy error: ' + error.message);
  }
});

const server = http.createServer((req, res) => proxy.web(req, res));
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

function report(): void {
  process.stdout.write('PORT=' + (server.address() as AddressInfo).port + '\n');
}

server.listen(preferredPort, '127.0.0.1', report);

process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
