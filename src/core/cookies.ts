/**
 * Cookie handling shared by the Coder app proxy and its tests.
 *
 * The proxy terminates dsh's own authentication server-side (a VS Code webview
 * is a third-party context for the app origin and does not keep dsh's
 * `SameSite=Strict` cookie), so it owns the `dsh-auth-*` cookies and forwards
 * only the others the browser happens to hold.
 */
export interface CookieState {
  /** `dsh-auth-...=...` obtained from the launch-token exchange. */
  dsh: string;
  /** `coder_signed_app_token=...` captured for WebSocket auth. */
  coder: string;
}

export function createCookieState(): CookieState {
  return { dsh: '', coder: '' };
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function isHopByHop(name: string): boolean {
  return HOP_BY_HOP.has(name.toLowerCase());
}

/** Remember dsh/coder cookies from an upstream `Set-Cookie` list. */
export function captureCookies(setCookie: string[] | undefined, state: CookieState): void {
  for (const header of setCookie ?? []) {
    const pair = header.split(';')[0].trim();
    const lower = pair.toLowerCase();
    if (lower.startsWith('dsh-auth-')) state.dsh = pair;
    else if (lower.startsWith('coder_signed_app_token=')) state.coder = pair;
  }
}

/**
 * The Cookie header for an upstream request: the browser's cookies minus the
 * dsh ones we own, plus our captured dsh and coder cookies.
 */
export function buildCookieHeader(incoming: string | undefined, state: CookieState): string {
  const parts: string[] = [];
  if (incoming) {
    for (const raw of incoming.split(';')) {
      const pair = raw.trim();
      if (!pair) continue;
      const name = pair.split('=')[0].trim().toLowerCase();
      if (name.startsWith('dsh-auth-') || name.startsWith('coder_signed_app_token')) continue;
      parts.push(pair);
    }
  }
  if (state.coder) parts.push(state.coder);
  if (state.dsh) parts.push(state.dsh);
  return parts.join('; ');
}
