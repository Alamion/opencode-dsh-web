import type * as http from 'node:http';
import { addCspHash, injectAppearanceSync, type AppearanceProfile } from './appearance';
import { injectWebviewBridge } from './webview-bridge';

export function isDocumentRequest(request: Pick<http.IncomingMessage, 'method' | 'headers' | 'url'>): boolean {
  const accept = String(request.headers.accept ?? '').toLowerCase();
  const dest = String(request.headers['sec-fetch-dest'] ?? '').toLowerCase();
  const url = request.url ?? '/';
  return request.method === 'GET' && (accept.includes('text/html') || dest === 'document' || dest === 'iframe' || url === '/' || url.startsWith('/?'));
}

/** Both proxy modes must install the same iframe integration, even without appearance sync. */
export function forwardOpenCodeResponse(
  upstream: http.IncomingMessage,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  appearance?: { profile: AppearanceProfile; syncPreferences: boolean },
): void {
  const headers = { ...upstream.headers } as http.OutgoingHttpHeaders;
  const encoding = String(headers['content-encoding'] ?? '').toLowerCase();
  if (request.method !== 'GET' || !String(headers['content-type']).toLowerCase().includes('text/html') || (encoding && encoding !== 'identity')) {
    response.writeHead(upstream.statusCode ?? 502, headers);
    upstream.pipe(response);
    return;
  }
  const chunks: Buffer[] = [];
  upstream.on('data', (chunk: Buffer) => chunks.push(chunk));
  upstream.on('end', () => {
    let html = Buffer.concat(chunks).toString('utf8');
    const hashes: string[] = [];
    if (appearance) {
      const result = injectAppearanceSync(html, appearance.profile, { syncPreferences: appearance.syncPreferences });
      html = result.html;
      hashes.push(result.hash);
    }
    const bridge = injectWebviewBridge(html);
    html = bridge.html;
    hashes.push(bridge.hash);
    const csp = headers['content-security-policy'];
    if (csp) {
      headers['content-security-policy'] = (Array.isArray(csp) ? csp : [String(csp)]).map((policy) =>
        hashes.reduce((value, hash) => addCspHash(value, hash), policy),
      ).join(', ');
    }
    delete headers['transfer-encoding'];
    delete headers.etag;
    headers['cache-control'] = 'no-store';
    headers['content-length'] = String(Buffer.byteLength(html));
    response.writeHead(upstream.statusCode ?? 502, headers);
    response.end(html);
  });
  upstream.on('error', () => response.destroy());
}
