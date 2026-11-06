import { describe, expect, it } from 'vitest';
import { choosePort } from '../src/core/net';

const free = () => Promise.resolve(true);
const busy = () => Promise.resolve(false);

describe('choosePort', () => {
  it('reuses a free saved port', async () => {
    const port = await choosePort({ saved: 44000, seed: 'x', base: 43000, span: 6000, cap: 50000, isFree: free });
    expect(port).toBe(44000);
  });

  it('waits for a busy saved port and then reuses it', async () => {
    let calls = 0;
    const isFree = () => Promise.resolve(++calls > 2);
    const port = await choosePort({
      saved: 44000,
      seed: 'x',
      base: 43000,
      span: 6000,
      cap: 50000,
      isFree,
      retries: 5,
      retryDelayMs: 0,
    });
    expect(port).toBe(44000);
  });

  it('falls back to a deterministic free port when the saved one stays busy', async () => {
    const isFree = (p: number) => Promise.resolve(p !== 44000);
    const first = await choosePort({ saved: 44000, seed: 'seed', base: 43000, span: 6000, cap: 50000, isFree, retries: 1, retryDelayMs: 0 });
    const second = await choosePort({ saved: 44000, seed: 'seed', base: 43000, span: 6000, cap: 50000, isFree, retries: 1, retryDelayMs: 0 });
    expect(first).toBeGreaterThanOrEqual(43000);
    expect(first).toBeLessThan(50000);
    expect(first).toBe(second);
  });

  it('returns 0 when nothing is free', async () => {
    const port = await choosePort({ saved: 0, seed: 'seed', base: 43000, span: 10, cap: 43005, isFree: busy });
    expect(port).toBe(0);
  });
});
