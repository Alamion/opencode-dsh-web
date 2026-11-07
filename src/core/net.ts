import * as net from 'node:net';
import { sleep, stableHash } from './util';

/** True when nothing is listening on 127.0.0.1:<port>. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

export interface ChoosePortOptions {
  /** Previously stored port to reuse when it is still free. */
  saved?: number;
  /** Seed for the deterministic fallback port (a workspace path or target key). */
  seed: string;
  /** Lowest port of the fallback range. */
  base: number;
  /** Size of the fallback range (hash modulo span). */
  span: number;
  /** Exclusive upper bound when probing upwards from the hashed port. */
  cap: number;
  /** Probe used for port availability; defaults to a real 127.0.0.1 bind. */
  isFree?: (port: number) => Promise<boolean>;
  /** How many times to re-check a busy saved port before giving up on it. */
  retries?: number;
  /** Delay between re-checks of the saved port, in milliseconds. */
  retryDelayMs?: number;
}

/**
 * Reuse the saved port when possible (so the webview origin stays stable), then
 * fall back to a deterministic per-seed port. Returns 0 when nothing is free.
 */
export async function choosePort(options: ChoosePortOptions): Promise<number> {
  const isFree = options.isFree ?? isPortFree;
  const retries = options.retries ?? 6;
  const retryDelayMs = options.retryDelayMs ?? 300;

  if (options.saved) {
    if (await isFree(options.saved)) return options.saved;
    // A previous window's proxy child may still be shutting down: wait a bit so
    // we keep the same origin (and the web UI state it holds).
    for (let attempt = 0; attempt < retries; attempt++) {
      await sleep(retryDelayMs);
      if (await isFree(options.saved)) return options.saved;
    }
  }

  const start = options.base + (stableHash(options.seed) % options.span);
  for (let candidate = start; candidate < options.cap; candidate++) {
    if (await isFree(candidate)) return candidate;
  }
  return 0;
}
