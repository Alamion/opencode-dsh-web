import { describe, expect, it } from 'vitest';
import { buildCookieHeader, captureCookies, createCookieState, isHopByHop } from '../src/core/cookies';

describe('cookies', () => {
  it('captures dsh and coder cookies and ignores others', () => {
    const state = createCookieState();
    captureCookies(
      [
        'dsh-auth-abc=v1.payload; Max-Age=10; Path=/',
        'coder_signed_app_token=jwt; Path=/',
        'theme=dark; Path=/',
      ],
      state,
    );
    expect(state.dsh).toBe('dsh-auth-abc=v1.payload');
    expect(state.coder).toBe('coder_signed_app_token=jwt');
  });

  it('owns dsh cookies and keeps everything else from the browser', () => {
    const state = createCookieState();
    state.dsh = 'dsh-auth-abc=ours';
    state.coder = 'coder_signed_app_token=jwt';
    const header = buildCookieHeader('theme=dark; dsh-auth-abc=stale; coder_signed_app_token=old', state);
    expect(header).toBe('theme=dark; coder_signed_app_token=jwt; dsh-auth-abc=ours');
  });

  it('injects the dsh cookie even when the browser sends none', () => {
    const state = createCookieState();
    state.dsh = 'dsh-auth-abc=ours';
    expect(buildCookieHeader(undefined, state)).toBe('dsh-auth-abc=ours');
  });

  it('knows hop-by-hop headers', () => {
    expect(isHopByHop('Connection')).toBe(true);
    expect(isHopByHop('transfer-encoding')).toBe(true);
    expect(isHopByHop('content-type')).toBe(false);
  });
});
