import { b64url, stripTrailingSlash } from './util';

export interface OpenCodeSession {
  id: string;
  time?: {
    created?: number;
    updated?: number;
    viewed?: number;
  };
}

/** OpenCode expects HTTP Basic with the literal user name `opencode`. */
export function basicAuth(password: string): string {
  return 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
}

function viewedAt(session: OpenCodeSession): number {
  return (session.time && session.time.viewed) || 0;
}

function touchedAt(session: OpenCodeSession): number {
  return Math.max(
    (session.time && session.time.updated) || 0,
    (session.time && session.time.created) || 0,
  );
}

/**
 * The chat the user actually opened (the web UI writes `time.viewed` when a
 * session is navigated to) wins over one that only received background updates.
 */
export function pickLatestSession(sessions: readonly OpenCodeSession[]): string | null {
  const sorted = [...sessions].sort((a, b) => {
    const va = viewedAt(a);
    const vb = viewedAt(b);
    if (va && vb && va !== vb) return vb - va;
    if (va && !vb) return -1;
    if (!va && vb) return 1;
    return touchedAt(b) - touchedAt(a);
  });
  return sorted.length > 0 && sorted[0].id ? sorted[0].id : null;
}

/** Deep link the OpenCode web UI understands: /server/<key>/session/<id>. */
export function sessionDeepLink(proxyUrl: string, sessionId: string): string {
  const origin = stripTrailingSlash(proxyUrl);
  return `${origin}/server/${b64url(origin)}/session/${sessionId}`;
}

export function parseCreatedSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).id === 'string') {
    return (data as Record<string, unknown>).id as string;
  }
  return typeof record.id === 'string' ? record.id : null;
}
