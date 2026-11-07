import { describe, expect, it } from 'vitest';
import { isCoderCliName, pickCoderCli } from '../src/core/coderCli';

describe('isCoderCliName', () => {
  it('accepts real CLI binaries across platforms', () => {
    expect(isCoderCliName('coder-linux-amd64')).toBe(true);
    expect(isCoderCliName('coder-darwin-arm64')).toBe(true);
    expect(isCoderCliName('coder.exe')).toBe(true);
    expect(isCoderCliName('coder')).toBe(true);
  });

  it('rejects signatures and temporary downloads', () => {
    expect(isCoderCliName('coder-linux-amd64.temp-abc.asc')).toBe(false);
    expect(isCoderCliName('coder_2.38.0_linux_amd64.tar.gz')).toBe(false);
    expect(isCoderCliName('something-else')).toBe(false);
  });
});

describe('pickCoderCli', () => {
  it('returns the newest candidate or the PATH fallback', () => {
    expect(pickCoderCli([{ path: '/a', mtimeMs: 1 }, { path: '/b', mtimeMs: 2 }])).toBe('/b');
    expect(pickCoderCli([])).toBe('coder');
    expect(pickCoderCli([], '/opt/coder')).toBe('/opt/coder');
  });
});
