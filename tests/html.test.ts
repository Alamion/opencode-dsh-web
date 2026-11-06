import { describe, expect, it } from 'vitest';
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
});
