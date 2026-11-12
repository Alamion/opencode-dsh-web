import { sha256Base64 } from './appearance';

/** Validate again at the extension boundary; never forward command/file URIs. */
export function externalWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    // Messages from web content are untrusted.
  }
  return;
}

/** Runs before the app, but only inside the sidebar iframe (not in a browser tab). */
export function webviewBridgeScript(): string {
  return `(() => {
  if (window.parent === window) return;
  // Electron can give the webview an opaque origin or suppress its referrer.
  // Send only to our parent window; the wrapper checks both source and origin.
  let parentOrigin = '*';
  try { const origin = new URL(document.referrer).origin; if (origin !== 'null') parentOrigin = origin; } catch {}
  function external(value) {
    try {
      const url = new URL(value, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      window.parent.postMessage({ type: 'opencode:openExternal', url: url.href }, parentOrigin);
      return true;
    } catch { return false; }
  }
  document.addEventListener('click', openAnchor, true);
  document.addEventListener('auxclick', openAnchor, true);
  function openAnchor(event) {
    if (event.button !== 0 && event.button !== 1) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.hasAttribute('download')) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin === location.origin && anchor.target !== '_blank') return;
    if (!external(url.href)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  const open = window.open;
  window.open = function(url, ...args) {
    if (url && external(String(url))) return null;
    return open.call(window, url, ...args);
  };

  // Hidden webviews can acquire a zero-sized layout; virtualized timelines then
  // report offset zero. Keep the last visible offset, never the hidden one.
  const storageKey = 'opencode-web:scroll';
  let snapshot;
  let pending;
  let hidden = false;
  let timer;
  let deadline = 0;
  let restoring = false;
  const route = () => location.pathname + location.search + location.hash;
  const viewport = () => document.querySelector('main .scroll-view__viewport');
  const visible = (el) => document.visibilityState !== 'hidden' && el && el.clientHeight > 0 && el.getClientRects().length > 0;
  const NativeResizeObserver = window.ResizeObserver;
  function remember() {
    const el = viewport();
    if (hidden || pending || !visible(el)) return;
    const top = el.getBoundingClientRect().top;
    const inset = Math.max(top, el.querySelector('[data-session-title]')?.getBoundingClientRect().bottom || top);
    const row = [...el.querySelectorAll('[data-timeline-key]')].find(row => row.getBoundingClientRect().bottom > inset);
    snapshot = { route: route(), top: el.scrollTop, bottom: el.scrollHeight - el.clientHeight - el.scrollTop <= 1,
      anchor: row && row.getAttribute('data-timeline-key'),
      offset: row && row.getBoundingClientRect().top - top };
  }
  function cancel() {
    pending = undefined;
    clearTimeout(timer);
  }
  function restore() {
    if (!pending) return;
    if (pending.route !== route() || Date.now() > deadline) { cancel(); return; }
    const el = viewport();
    if (visible(el)) {
      // OpenCode ignores programmatic scrolls until its gesture guard is armed;
      // otherwise auto-follow immediately snaps back to the end after reveal.
      if (!pending.bottom) {
        restoring = true;
        el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
        restoring = false;
      }
      const row = pending.anchor && [...el.querySelectorAll('[data-timeline-key]')].find(row => row.getAttribute('data-timeline-key') === pending.anchor);
      const top = pending.bottom ? el.scrollHeight - el.clientHeight : row ? el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top - pending.offset : pending.top;
      el.scrollTop = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
    }
    // Layout/virtualizer callbacks may run after visibilitychange/ResizeObserver.
    timer = setTimeout(restore, 50);
  }
  function resume(saved, duration) {
    cancel();
    if (!saved || saved.route !== route()) return;
    snapshot = saved;
    pending = saved;
    deadline = Date.now() + duration;
    restore();
  }
  function visibility() {
    const el = viewport();
    if (!el) return;
    const next = document.visibilityState === 'hidden' || !visible(el);
    if (next && !hidden) {
      hidden = true;
      cancel();
    } else if (!next && hidden) {
      hidden = false;
      resume(snapshot, 1000);
    }
  }
  document.addEventListener('scroll', remember, true);
  document.addEventListener('visibilitychange', visibility);
  // Stop restoring immediately when the user scrolls, clicks or changes chats.
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    document.addEventListener(type, () => { if (!restoring) { cancel(); hidden = false; } }, true);
  }
  window.addEventListener('pagehide', () => {
    try { if (snapshot && snapshot.route === route()) sessionStorage.setItem(storageKey, JSON.stringify(snapshot)); } catch {}
  });
  // Appearance synchronization deliberately reloads an unfocused panel.
  // beforeunload runs while its visible layout is still measurable.
  window.addEventListener('beforeunload', () => {
    remember();
    try { if (snapshot && snapshot.route === route()) sessionStorage.setItem(storageKey, JSON.stringify(snapshot)); } catch {}
  });
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    sessionStorage.removeItem(storageKey);
    if (saved && Number.isFinite(saved.top) && saved.top >= 0) resume(saved, 5000);
  } catch {}
  document.addEventListener('DOMContentLoaded', () => {
    const observer = new NativeResizeObserver(() => { visibility(); remember(); });
    observer.observe(document.documentElement);
    let observed;
    function bindViewport() {
      const el = viewport();
      if (el === observed) return;
      if (observed) observer.unobserve(observed);
      observed = el;
      if (el) observer.observe(el);
      remember();
    }
    // The SPA creates/replaces its timeline after DOMContentLoaded. Observe the
    // timeline itself: hiding an iframe need not resize its document element.
    new MutationObserver(bindViewport).observe(document.documentElement, { childList: true, subtree: true });
    bindViewport();
    remember();
  });
})();`;
}

export function injectWebviewBridge(html: string): { html: string; hash: string } {
  const script = webviewBridgeScript();
  const tag = `<script id="oc-webview-bridge">${script}</script>`;
  return { html: html.includes('<head>') ? html.replace('<head>', '<head>' + tag) : tag + html, hash: sha256Base64(script) };
}
