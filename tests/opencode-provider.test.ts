import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { OpenCodeProvider } from '../src/providers/opencode';

afterEach(() => vi.restoreAllMocks());

describe('OpenCode external links', () => {
  it('delegates to the system browser API, preserving launch query parameters', () => {
    const openExternal = vi.spyOn(vscode.env, 'openExternal');
    let receive: (message: object) => void = () => {};
    const view = { webview: { options: {}, html: '', onDidReceiveMessage: (callback: typeof receive) => { receive = callback; } } };
    const provider = new OpenCodeProvider({} as vscode.ExtensionContext, '', '', '', async () => false);
    provider.resolveWebviewView(view as unknown as vscode.WebviewView);
    receive({ type: 'openExternal', url: 'http://127.0.0.1:3297/?token=example' });
    expect(openExternal).toHaveBeenCalledWith(vscode.Uri.parse('http://127.0.0.1:3297/?token=example'));
    for (const url of ['command:unsafe', 'file:///etc/passwd', {}, null]) receive({ type: 'openExternal', url });
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
