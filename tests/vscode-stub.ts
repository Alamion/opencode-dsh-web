// Minimal stand-in for the `vscode` module so provider modules can be imported
// in tests. Core modules under src/core never import vscode.
import type * as vscode from 'vscode';

export const version = '1.90.0';

export const workspace = {
  workspaceFolders: [] as vscode.WorkspaceFolder[],
  getConfiguration: () => ({
    get: <T>(_key: string, fallback?: T): T | undefined => fallback,
    update: async () => undefined,
  }),
};

export const window = {
  showWarningMessage: async (): Promise<undefined> => undefined,
  showQuickPick: async (): Promise<undefined> => undefined,
  createTerminal: () => ({ show: () => undefined, sendText: () => undefined }),
  withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
  registerWebviewViewProvider: () => ({ dispose: () => undefined }),
};

export const commands = {
  registerCommand: () => ({ dispose: () => undefined }),
  executeCommand: async (): Promise<undefined> => undefined,
};

export const env = { openExternal: async (): Promise<boolean> => true };
export const Uri = { parse: (value: string): string => value };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
