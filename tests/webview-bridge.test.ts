import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { externalWebUrl, injectWebviewBridge, webviewBridgeScript } from '../src/core/webview-bridge';
import { sha256Base64 } from '../src/core/appearance';

function harness(options: { embedded?: boolean; saved?: object; mounted?: boolean; referrer?: string } = {}) {
  const listeners = new Map<string, (event?: any) => void>();
  const timers = new Map<number, () => void>();
  const sent: unknown[] = [];
  const gestures: unknown[] = [];
  const storage = new Map<string, string>();
  if (options.saved) storage.set('opencode-web:scroll', JSON.stringify(options.saved));
  const location = { href: 'http://localhost:4000/session/one', origin: 'http://localhost:4000', pathname: '/session/one', search: '', hash: '' };
  let clock = 0;
  let resize = () => {};
  let nextTimer = 0;
  let rows: object[] = [];
  let mounted = options.mounted !== false;
  const el = {
    scrollTop: 500, clientHeight: 600, scrollHeight: 2000,
    getClientRects: () => el.clientHeight ? [{}] : [],
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => null,
    querySelectorAll: () => rows,
    dispatchEvent: (event: unknown) => { gestures.push(event); return true; },
  };
  const document = {
    referrer: options.referrer ?? 'https://webview.example/', visibilityState: 'visible', documentElement: {},
    querySelector: () => mounted ? el : null,
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  };
  const window: any = {
    parent: { postMessage: (message: unknown, origin: string) => sent.push({ message, origin }) },
    open: () => 'native-open',
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  };
  if (options.embedded === false) window.parent = window;
  class Element {
    constructor(readonly anchor: object) {}
    closest() { return this.anchor; }
  }
  const ResizeObserver = class { constructor(callback: () => void) { resize = callback; } observe() {} unobserve() {} };
  window.ResizeObserver = ResizeObserver;
  runInNewContext(webviewBridgeScript(), {
    window, document, location, URL, Element,
    WheelEvent: class {},
    Date: { now: () => clock },
    ResizeObserver,
    MutationObserver: class { observe() {} },
    sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  listeners.get('DOMContentLoaded')?.();
  function fire(type: string, event?: unknown) { listeners.get(type)?.(event); }
  function tick() {
    clock += 50;
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach(callback => callback());
  }
  function click(href: string, target = '', button = 0) {
    const event = { target: new Element({ href, target, hasAttribute: () => false }), button, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    fire(button === 1 ? 'auxclick' : 'click', event);
    return event;
  }
  return { window, document, location, el, sent, storage, gestures, fire, tick, click, mount: () => { mounted = true; }, resize: () => resize(), rows: (next: object[]) => { rows = next; } };
}

describe('externalWebUrl', () => {
  it('keeps local web URLs including their query and fragment', () => {
    expect(externalWebUrl('http://127.0.0.1:3297/?token=example#models')).toBe('http://127.0.0.1:3297/?token=example#models');
  });
  it.each(['command:workbench.action.closeWindow', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', '/relative', null, {}])('rejects %s', value => {
    expect(externalWebUrl(value)).toBeUndefined();
  });
});

describe('webview bridge', () => {
  it('intercepts an external anchor before the app and forwards its exact URL', () => {
    const h = harness();
    expect(h.click('http://127.0.0.1:3297/?token=example').prevented).toBe(true);
    expect(h.sent).toEqual([{ origin: 'https://webview.example', message: { type: 'opencode:openExternal', url: 'http://127.0.0.1:3297/?token=example' } }]);
  });
  it('covers middle-clicks, target blank and programmatic popup links', () => {
    const h = harness();
    expect(h.click('https://example.org', '', 1).stopped).toBe(true);
    expect(h.click('http://localhost:4000/page', '_blank').prevented).toBe(true);
    expect(h.window.open('https://example.org')).toBe(null);
    expect(h.sent).toHaveLength(3);
  });
  it('leaves internal navigation, hashes and non-web protocols alone', () => {
    const h = harness();
    expect(h.click('http://localhost:4000/session/two').prevented).toBe(false);
    expect(h.click('http://localhost:4000/session/one#message').prevented).toBe(false);
    expect(h.click('command:unsafe').prevented).toBe(false);
    expect(h.sent).toEqual([]);
  });
  it('does not change standalone browser behavior', () => {
    const h = harness({ embedded: false });
    expect(h.window.open('https://example.org')).toBe('native-open');
    expect(h.sent).toEqual([]);
  });
  it.each(['', 'vscode-webview://opaque-id/'])('works with an opaque or suppressed webview referrer: %s', referrer => {
    const h = harness({ referrer });
    expect(h.click('https://example.org/').prevented).toBe(true);
    expect(h.sent).toEqual([{ origin: '*', message: { type: 'opencode:openExternal', url: 'https://example.org/' } }]);
  });
  it('restores the last visible scroll after zero-size layout, including delayed resets', () => {
    const h = harness();
    h.el.clientHeight = 0;
    h.resize();
    h.el.scrollTop = 0;
    h.fire('scroll');
    h.el.clientHeight = 600;
    h.resize();
    expect(h.el.scrollTop).toBe(500);
    expect(h.gestures.length).toBeGreaterThan(0);
    h.el.scrollTop = 0;
    h.tick();
    expect(h.el.scrollTop).toBe(500);
  });
  it('does not undo intentional scrolling after the panel is shown', () => {
    const h = harness();
    h.document.visibilityState = 'hidden'; h.fire('visibilitychange');
    h.el.scrollTop = 0;
    h.document.visibilityState = 'visible'; h.fire('visibilitychange');
    h.fire('wheel');
    h.el.scrollTop = 100;
    h.tick();
    expect(h.el.scrollTop).toBe(100);
  });
  it('retains auto-follow when hiding a chat already at the bottom', () => {
    const h = harness();
    h.el.scrollTop = 1400; h.fire('scroll');
    h.document.visibilityState = 'hidden'; h.fire('visibilitychange');
    h.el.scrollHeight = 2200; h.el.scrollTop = 0;
    h.document.visibilityState = 'visible'; h.fire('visibilitychange');
    expect(h.el.scrollTop).toBe(1600);
    expect(h.gestures).toHaveLength(0);
  });
  it('never applies an old chat position to a different route', () => {
    const h = harness();
    h.document.visibilityState = 'hidden'; h.fire('visibilitychange');
    h.location.pathname = '/session/two'; h.el.scrollTop = 0;
    h.document.visibilityState = 'visible'; h.fire('visibilitychange'); h.tick();
    expect(h.el.scrollTop).toBe(0);
  });
  it('restores through a reload and consumes the saved state once', () => {
    const h = harness();
    h.fire('beforeunload'); h.fire('pagehide');
    const saved = JSON.parse(h.storage.get('opencode-web:scroll')!);
    const next = harness({ saved });
    expect(next.el.scrollTop).toBe(500);
    expect(next.storage.size).toBe(0);
  });
  it('does not discard reload state before the SPA mounts its timeline', () => {
    const h = harness({ saved: { route: '/session/one', top: 400 }, mounted: false });
    h.resize();
    h.mount();
    h.tick();
    expect(h.el.scrollTop).toBe(400);
  });
  it('anchors to a timeline row when virtualization changes its measured position', () => {
    const h = harness();
    let rowTop = 80;
    h.rows([{ getAttribute: () => 'message-one', getBoundingClientRect: () => ({ top: rowTop, bottom: rowTop + 400 }) }]);
    h.fire('scroll');
    h.document.visibilityState = 'hidden'; h.fire('visibilitychange');
    rowTop = 180;
    h.document.visibilityState = 'visible'; h.fire('visibilitychange');
    expect(h.el.scrollTop).toBe(600);
  });
  it('bounds retries instead of fighting app scrolling indefinitely', () => {
    const h = harness({ saved: { route: '/session/one', top: 400 } });
    for (let i = 0; i < 105; i++) h.tick();
    h.el.scrollTop = 100;
    h.tick();
    expect(h.el.scrollTop).toBe(100);
  });
  it('injects before app scripts with a matching CSP hash', () => {
    const result = injectWebviewBridge('<html><head><script src="app.js"></script></head></html>');
    expect(result.html.indexOf('oc-webview-bridge')).toBeLessThan(result.html.indexOf('app.js'));
    expect(result.hash).toBe(sha256Base64(webviewBridgeScript()));
  });
});
