import { describe, expect, it } from 'vitest';
import {
  buildApps,
  coderAppHost,
  chooseDeployment,
  chooseWorkspace,
  parseLaunchToken,
  pickAppSlug,
  resolveTarget,
} from '../src/core/coder';
import type { FetchLike } from '../src/core/coder';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fakeFetch = (handler: (url: string) => Response): FetchLike =>
  ((input: string | URL | Request) => Promise.resolve(handler(String(input)))) as unknown as FetchLike;

describe('chooseDeployment', () => {
  it('uses configured url and token first', () => {
    const deployment = chooseDeployment({
      configuredUrl: 'https://studio.example.test/',
      configuredToken: 'cfg',
      sessionPath: '',
      sessionPathToken: '',
      candidates: [{ dir: '/d', url: 'https://other', token: 'disk', mtimeMs: 5 }],
    });
    expect(deployment).toEqual({ url: 'https://studio.example.test', token: 'cfg', source: undefined });
  });

  it('prefers a candidate whose url matches the configured one', () => {
    const deployment = chooseDeployment({
      configuredUrl: 'https://studio.example.test',
      configuredToken: '',
      sessionPath: '',
      sessionPathToken: '',
      candidates: [
        { dir: '/new', url: 'https://other', token: 'other', mtimeMs: 100 },
        { dir: '/match', url: 'https://studio.example.test', token: 'match', mtimeMs: 1 },
      ],
    });
    expect(deployment.token).toBe('match');
    expect(deployment.source).toBe('/match');
  });

  it('honours an explicit session file', () => {
    const deployment = chooseDeployment({
      configuredUrl: '',
      configuredToken: '',
      sessionPath: '/tmp/session',
      sessionPathToken: 'file-token',
      candidates: [{ dir: '/c', url: 'https://studio.example.test', token: 'disk', mtimeMs: 9 }],
    });
    expect(deployment).toEqual({ url: 'https://studio.example.test', token: 'file-token', source: '/tmp/session' });
  });
});

describe('chooseWorkspace', () => {
  const ws = (name: string, status = 'stopped', lastUsed?: string) => ({
    name,
    last_used_at: lastUsed,
    latest_build: { status },
  });

  it('prefers an explicit env name', () => {
    expect(chooseWorkspace([ws('a'), ws('b')], 'b')).toEqual({ ok: true, name: 'b' });
  });

  it('uses the sole workspace', () => {
    expect(chooseWorkspace([ws('only')])).toEqual({ ok: true, name: 'only' });
  });

  it('uses the only running workspace', () => {
    expect(chooseWorkspace([ws('a', 'running'), ws('b', 'stopped')])).toEqual({ ok: true, name: 'a' });
  });

  it('falls back to the most recently used', () => {
    const choice = chooseWorkspace([ws('a', 'running', '2026-01-01T00:00:00Z'), ws('b', 'running', '2026-02-01T00:00:00Z')]);
    expect(choice).toEqual({ ok: true, name: 'b' });
  });

  it('reports ambiguity without any hint', () => {
    expect(chooseWorkspace([ws('a', 'running'), ws('b', 'running')])).toEqual({
      ok: false,
      reason: 'ambiguous',
      names: ['a', 'b'],
    });
  });

  it('reports no workspace for an empty list', () => {
    expect(chooseWorkspace([])).toEqual({ ok: false, reason: 'no-workspace' });
  });
});

describe('pickAppSlug', () => {
  it('uses a configured slug', () => {
    expect(pickAppSlug([{ slug: 'a' }, { slug: 'b' }], 'b')).toEqual({ ok: true, slug: 'b' });
  });
  it('uses the only app', () => {
    expect(pickAppSlug([{ slug: 'demo' }], '')).toEqual({ ok: true, slug: 'demo' });
  });
  it('asks to select among several', () => {
    expect(pickAppSlug([{ slug: 'demo' }, { slug: 'harness' }], '')).toEqual({
      ok: false,
      reason: 'select-app',
      slugs: ['demo', 'harness'],
    });
  });
  it('reports no app', () => {
    expect(pickAppSlug([], '')).toEqual({ ok: false, reason: 'no-app' });
  });
});

describe('coderAppHost', () => {
  it('lower-cases and joins slug--workspace--owner', () => {
    expect(coderAppHost({ slug: 'demo', workspace: 'MyWs', owner: 'User', domain: 'apps.example' })).toBe(
      'demo--myws--user.apps.example',
    );
  });
  it('includes the agent label when given', () => {
    expect(coderAppHost({ slug: 'demo', agent: 'main', workspace: 'ws', owner: 'u', domain: 'd' })).toBe('demo--main--ws--u.d');
  });
});

describe('parseLaunchToken', () => {
  it('extracts the token from the studio-proxy launch page', () => {
    const html = '<title>DEMO</title><script>location.replace("./?token=AbC_-.123")</script>';
    expect(parseLaunchToken(html)).toBe('AbC_-.123');
  });
  it('returns null for a normal page', () => {
    expect(parseLaunchToken('<html><body>app</body></html>')).toBeNull();
  });
});

describe('buildApps', () => {
  it('reads resources[].agents[].apps[]', () => {
    const build = {
      resources: [
        { agents: [{ apps: [{ slug: 'demo', display_name: 'DEMO', url: 'http://127.0.0.1:3081' }] }] },
        { agents: [{ apps: [{ slug: 'harness' }] }] },
      ],
    };
    expect(buildApps(build)).toEqual([
      { slug: 'demo', displayName: 'DEMO', url: 'http://127.0.0.1:3081' },
      { slug: 'harness', displayName: undefined, url: undefined },
    ]);
  });
  it('tolerates missing shapes', () => {
    expect(buildApps(null)).toEqual([]);
    expect(buildApps({})).toEqual([]);
  });
});

describe('resolveTarget', () => {
  const deployment = { url: 'https://studio.example.test', token: 't' };
  const settings = { owner: '', workspace: '', appSlug: '', appDomain: '', agent: '' };

  const happyRoutes = (url: string): Response => {
    if (url.endsWith('/api/v2/users/me')) return json({ username: 'vsemenov' });
    if (url.includes('/api/v2/workspaces?q=')) return json({ workspaces: [{ name: 'ws', latest_build: { status: 'running' } }] });
    if (url.includes('/api/v2/users/vsemenov/workspace/ws')) return json({ id: 'wsid', latest_build: { id: 'b1', status: 'running' } });
    if (url.includes('/api/v2/workspacebuilds/b1')) return json({ resources: [{ agents: [{ apps: [{ slug: 'demo', display_name: 'DEMO' }] }] }] });
    return new Response('nope', { status: 404 });
  };

  it('resolves a running workspace and auto-detects the app slug', async () => {
    const target = await resolveTarget(deployment, settings, { fetchImpl: fakeFetch(happyRoutes) });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.owner).toBe('vsemenov');
    expect(target.workspace).toBe('ws');
    expect(target.appSlug).toBe('demo');
    expect(target.appHost).toBe('demo--ws--vsemenov.studio.example.test');
    expect(target.appUrl).toBe('http://demo--ws--vsemenov.studio.example.test');
  });

  it('reports an expired session', async () => {
    const target = await resolveTarget(deployment, settings, { fetchImpl: fakeFetch(() => json({}, 401)) });
    expect(target).toEqual({ ok: false, error: 'expired' });
  });

  it('reports ambiguous workspaces', async () => {
    const routes = (url: string): Response => {
      if (url.endsWith('/api/v2/users/me')) return json({ username: 'u' });
      if (url.includes('/api/v2/workspaces?q=')) return json({ workspaces: [{ name: 'a', latest_build: { status: 'running' } }, { name: 'b', latest_build: { status: 'running' } }] });
      return new Response('nope', { status: 404 });
    };
    const target = await resolveTarget(deployment, settings, { fetchImpl: fakeFetch(routes) });
    expect(target).toEqual({ ok: false, error: 'ambiguous', owner: 'u', names: ['a', 'b'] });
  });

  it('leaves appSlug empty for a stopped workspace', async () => {
    const routes = (url: string): Response => {
      if (url.endsWith('/api/v2/users/me')) return json({ username: 'u' });
      if (url.includes('/api/v2/workspaces?q=')) return json({ workspaces: [{ name: 'ws', latest_build: { status: 'stopped' } }] });
      if (url.includes('/workspace/ws')) return json({ id: 'wsid', latest_build: { id: 'b2', status: 'stopped' } });
      return new Response('nope', { status: 404 });
    };
    const target = await resolveTarget(deployment, settings, { fetchImpl: fakeFetch(routes) });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.status).toBe('stopped');
    expect(target.appSlug).toBe('');
    expect(target.appUrl).toBe('');
  });

  it('lists candidates when several apps exist', async () => {
    const routes = (url: string): Response => {
      if (url.includes('/api/v2/workspacebuilds/b1')) return json({ resources: [{ agents: [{ apps: [{ slug: 'demo' }, { slug: 'harness' }] }] }] });
      return happyRoutes(url);
    };
    const target = await resolveTarget(deployment, settings, { fetchImpl: fakeFetch(routes) });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.appSlug).toBe('');
    expect(target.candidates).toEqual(['demo', 'harness']);
  });

  it('honours a configured app slug', async () => {
    const target = await resolveTarget(deployment, { ...settings, appSlug: 'harness' }, { fetchImpl: fakeFetch(happyRoutes) });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.appSlug).toBe('harness');
    expect(target.appHost).toBe('harness--ws--vsemenov.studio.example.test');
  });
});
