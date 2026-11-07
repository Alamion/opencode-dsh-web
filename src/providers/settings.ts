import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { chooseDeployment, CoderDeployment, CoderSettings, SessionCandidate } from '../core/coder';
import { CoderCliCandidate, isCoderCliName, pickCoderCli } from '../core/coderCli';
import { fileExists, fileMtimeMs, listEntries, readTextFile, stripTrailingSlash } from '../core/util';

export function opencodeConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('opencodeWeb');
}

export function dshConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('dshWeb');
}

/** OpenCode server password: the setting, else ~/.config/opencode/service.json. */
export function readOpenCodePassword(): string {
  const configured = opencodeConfig().get<string>('password', '');
  if (configured) return configured;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'service.json'), 'utf8');
    return (JSON.parse(raw) as { password?: string }).password ?? '';
  } catch {
    return '';
  }
}

const CODER_GLOBAL_STORAGE = ['.config', 'Code', 'User', 'globalStorage', 'coder.coder-remote'];

/** Coder session token + URL pairs on disk; chooseDeployment picks the best. */
export function coderSessionCandidates(): SessionCandidate[] {
  const home = os.homedir();
  const dirs = [path.join(home, '.config', 'coderv2'), ...listEntries(path.join(home, ...CODER_GLOBAL_STORAGE))];
  const candidates: SessionCandidate[] = [];
  for (const dir of dirs) {
    const sessionPath = path.join(dir, 'session');
    const token = readTextFile(sessionPath);
    if (!token) continue;
    candidates.push({
      dir,
      url: stripTrailingSlash(readTextFile(path.join(dir, 'url'))),
      token,
      mtimeMs: fileMtimeMs(sessionPath),
    });
  }
  return candidates;
}

export function readCoderDeployment(): CoderDeployment {
  const config = dshConfig();
  const sessionPath = config.get<string>('coder.sessionPath', '');
  return chooseDeployment({
    configuredUrl: config.get<string>('coder.url', ''),
    configuredToken: config.get<string>('coder.token', ''),
    sessionPath,
    sessionPathToken: sessionPath ? readTextFile(sessionPath) : '',
    candidates: coderSessionCandidates(),
  });
}

export function coderSettings(): CoderSettings {
  const config = dshConfig();
  return {
    owner: config.get<string>('coder.owner', ''),
    workspace: config.get<string>('coder.workspace', ''),
    appSlug: config.get<string>('coder.appSlug', ''),
    appDomain: config.get<string>('coder.appDomain', ''),
    agent: config.get<string>('coder.agent', ''),
  };
}

/** The coder CLI bundled by the coder-remote extension, then `coder` on PATH. */
export function coderCliPath(): string {
  const explicit = dshConfig().get<string>('coder.cli', '');
  if (explicit && fileExists(explicit)) return explicit;

  const home = os.homedir();
  const candidates: CoderCliCandidate[] = [];
  for (const dir of listEntries(path.join(home, ...CODER_GLOBAL_STORAGE))) {
    for (const entry of listEntries(path.join(dir, 'bin'))) {
      if (!isCoderCliName(path.basename(entry))) continue;
      if (!fileExists(entry)) continue;
      candidates.push({ path: entry, mtimeMs: fileMtimeMs(entry) });
    }
  }
  return pickCoderCli(candidates);
}
