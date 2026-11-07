import { describe, expect, it } from 'vitest';
import { basicAuth, chooseOpenCodeMode, parseCreatedSessionId, pickLatestSession, sessionDeepLink } from '../src/core/opencode';

describe('chooseOpenCodeMode', () => {
  it('keeps local by default and when no Coder workspace is configured', () => {
    expect(chooseOpenCodeMode('local', 'ws')).toBe('local');
    expect(chooseOpenCodeMode('auto', '')).toBe('local');
  });

  it('uses Coder explicitly or automatically when a workspace is set', () => {
    expect(chooseOpenCodeMode('coder', '')).toBe('coder');
    expect(chooseOpenCodeMode('auto', 'ws')).toBe('coder');
  });
});

describe('basicAuth', () => {
  it('encodes opencode:<password>', () => {
    const header = basicAuth('secret');
    const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString('utf8');
    expect(decoded).toBe('opencode:secret');
  });
});

describe('pickLatestSession', () => {
  it('returns null for an empty list', () => {
    expect(pickLatestSession([])).toBeNull();
  });

  it('prefers the session the user viewed over a background update', () => {
    const sessions = [
      { id: 'background', time: { updated: 9_000 } },
      { id: 'viewed', time: { viewed: 5_000, updated: 5_000 } },
    ];
    expect(pickLatestSession(sessions)).toBe('viewed');
  });

  it('falls back to the most recently touched session', () => {
    const sessions = [
      { id: 'older', time: { updated: 1_000 } },
      { id: 'newer', time: { created: 2_000 } },
    ];
    expect(pickLatestSession(sessions)).toBe('newer');
  });

  it('compares two viewed sessions by viewed time', () => {
    const sessions = [
      { id: 'a', time: { viewed: 1_000 } },
      { id: 'b', time: { viewed: 3_000 } },
    ];
    expect(pickLatestSession(sessions)).toBe('b');
  });
});

describe('sessionDeepLink', () => {
  it('builds /server/<key>/session/<id>', () => {
    expect(sessionDeepLink('http://127.0.0.1:46127/', 'abc')).toBe(
      'http://127.0.0.1:46127/server/aHR0cDovLzEyNy4wLjAuMTo0NjEyNw/session/abc',
    );
  });
});

describe('parseCreatedSessionId', () => {
  it('reads nested and flat ids', () => {
    expect(parseCreatedSessionId({ data: { id: 'one' } })).toBe('one');
    expect(parseCreatedSessionId({ id: 'two' })).toBe('two');
    expect(parseCreatedSessionId({})).toBeNull();
    expect(parseCreatedSessionId(null)).toBeNull();
  });
});
