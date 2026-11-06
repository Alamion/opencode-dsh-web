import * as fs from 'node:fs';

/** base64url without padding, as used by the OpenCode web UI for server keys. */
export function b64url(input: string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Deterministic 31-based hash used to derive per-workspace proxy ports. */
export function stableHash(seed: string): number {
  let hash = 0;
  for (const byte of Buffer.from(seed)) hash = (hash * 31 + byte) >>> 0;
  return hash;
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readTextFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

export function fileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function listEntries(parent: string): string[] {
  try {
    return fs.readdirSync(parent).map((entry) => `${parent}/${entry}`);
  } catch {
    return [];
  }
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}
