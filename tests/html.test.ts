import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { dshFrame, dshMessage, dshTokenPrompt, opencodeFrame } from '../src/core/html';

describe('dshMessage', () => {
  it('renders the title, detail and action buttons', () => {
    const html = dshMessage('Title', 'Detail', [
      { act: 'coderLogin', label: 'Coder Login' },
      { act: 'retry', label: 'Retry' },
    ]);
    expect(html).toContain('Title');
    expect(html).toContain('Detail');
    expect(html).toContain('data-act="coderLogin"');
    expect(html).toContain('data-act="retry"');
    expect(html).toContain('acquireVsCodeApi');
  });
});

describe('dshFrame', () => {
  it('allows only the frame origin in the CSP and embeds the src', () => {
    const html = dshFrame('http://127.0.0.1:40303/');
    expect(html).toContain('frame-src http://127.0.0.1:40303;');
    expect(html).toContain('src="http://127.0.0.1:40303/"');
  });
});

describe('dshTokenPrompt', () => {
  it('posts the pasted launch URL back to the extension', () => {
    const html = dshTokenPrompt('http://127.0.0.1:3080');
    expect(html).toContain('type: \'setToken\'');
    expect(html).toContain('http://127.0.0.1:3080/?token=…');
  });
});

describe('opencodeFrame', () => {
  it('frames the proxy and handles navigation messages', () => {
    const html = opencodeFrame('http://127.0.0.1:46127', 'http://127.0.0.1:46127/server/key/session/abc');
    expect(html).toContain('frame-src http://127.0.0.1:46127;');
    expect(html).toContain('/server/key/session/abc');
    expect(html).toContain("m.type === 'navigate'");
  });
  it('keeps layout dimensions while the iframe is loading', () => {
    const html = opencodeFrame('http://127.0.0.1:46127', 'http://127.0.0.1:46127/');
    expect(html).toContain('visibility:hidden');
    expect(html).not.toContain('display:none');
  });
  it('forwards only HTTP(S) links from the configured iframe source and origin', () => {
    const origin = 'http://127.0.0.1:46127';
    const html = opencodeFrame(origin, origin + '/');
    const sent: unknown[] = [];
    let receive: (event: object) => void = () => {};
    const frame = { contentWindow: {}, addEventListener: () => {}, src: origin + '/' };
    const window = { addEventListener: (_type: string, callback: typeof receive) => { receive = callback; } };
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
      acquireVsCodeApi: () => ({ postMessage: (message: unknown) => sent.push(message) }),
      document: { getElementById: (id: string) => id === 'frame' ? frame : {} },
      window, URL, setTimeout: () => {},
    });
    const data = { type: 'opencode:openExternal', url: 'https://example.org/page' };
    receive({ source: {}, origin, data });
    receive({ source: frame.contentWindow, origin: 'https://untrusted.example', data });
    receive({ source: frame.contentWindow, origin, data: { ...data, url: 'command:unsafe' } });
    expect(sent).toEqual([]);
    receive({ source: frame.contentWindow, origin, data });
    expect(sent).toEqual([{ type: 'openExternal', url: data.url }]);
    receive({ source: frame.contentWindow, origin, data: { type: 'navigate', url: 'https://untrusted.example/' } });
    receive({ source: window, data: { type: 'navigate', url: 'https://untrusted.example/' } });
    expect(frame.src).toBe(origin + '/');
    receive({ source: null, data: { type: 'navigate', url: origin + '/session/new' } });
    expect(frame.src).toBe(origin + '/session/new');
  });
});
