import { describe, expect, it } from 'vitest';
import { b64url, hostnameOf, stableHash, stripTrailingSlash } from '../src/core/util';

describe('b64url', () => {
  it('is url-safe and unpadded', () => {
    const value = b64url('http://127.0.0.1:46127');
    expect(value).toBe('aHR0cDovLzEyNy4wLjAuMTo0NjEyNw');
    expect(value).not.toMatch(/[+/=]/);
  });
});

describe('stripTrailingSlash', () => {
  it('removes one or many trailing slashes', () => {
    expect(stripTrailingSlash('http://x/')).toBe('http://x');
    expect(stripTrailingSlash('http://x///')).toBe('http://x');
    expect(stripTrailingSlash('http://x')).toBe('http://x');
  });
});

describe('stableHash', () => {
  it('is deterministic and unsigned', () => {
    expect(stableHash('/home/user/project')).toBe(stableHash('/home/user/project'));
    expect(stableHash('/a')).not.toBe(stableHash('/b'));
    expect(stableHash('x')).toBeGreaterThanOrEqual(0);
  });
});

describe('hostnameOf', () => {
  it('extracts a host and tolerates junk', () => {
    expect(hostnameOf('http://studio.example.test')).toBe('studio.example.test');
    expect(hostnameOf('https://a.b.c:8443/x')).toBe('a.b.c');
    expect(hostnameOf('not a url')).toBe('');
  });
});
