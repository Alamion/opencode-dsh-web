export interface CoderCliCandidate {
  path: string;
  mtimeMs: number;
}

/**
 * coder-remote downloads several files into `bin/` (`coder-linux-amd64`, a
 * `.temp-*.asc` signature, platform variants). Accept only real CLI binaries.
 */
export function isCoderCliName(name: string): boolean {
  if (/\.(asc|tar|tgz|gz|zip|sha256|sig)$/i.test(name)) return false;
  if (name.includes('.temp-')) return false;
  const base = name.replace(/\.exe$/i, '');
  return /^coder(-[a-z0-9_]+)*$/i.test(base);
}

/** The newest candidate, or the plain `coder` from PATH. */
export function pickCoderCli(candidates: readonly CoderCliCandidate[], fallback = 'coder'): string {
  let best: CoderCliCandidate | undefined;
  for (const candidate of candidates) {
    if (!best || candidate.mtimeMs > best.mtimeMs) best = candidate;
  }
  return best ? best.path : fallback;
}
