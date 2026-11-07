import { hostnameOf } from './util';

export interface CoderDeployment {
  /** Deployment root URL without a trailing slash. */
  url: string;
  /** Session token sent as `Coder-Session-Token`. */
  token: string;
  /** Where the token came from (a settings key or a file path), for messages. */
  source?: string;
}

export interface SessionCandidate {
  dir: string;
  url: string;
  token: string;
  mtimeMs: number;
}

export interface DeploymentInput {
  configuredUrl: string;
  configuredToken: string;
  /** Explicit session file; when set, its token is used verbatim. */
  sessionPath: string;
  sessionPathToken: string;
  candidates: readonly SessionCandidate[];
}

/**
 * Pick the deployment URL and session token from settings or from the Coder CLI
 * / VS Code extension config on disk. Prefers a candidate whose URL matches the
 * configured URL, then the freshest one.
 */
export function chooseDeployment(input: DeploymentInput): CoderDeployment {
  const url = input.configuredUrl.trim().replace(/\/+$/, '');
  if (input.sessionPath) {
    const fallbackUrl = url || input.candidates.find((c) => c.url)?.url || '';
    return {
      url: fallbackUrl,
      token: input.configuredToken.trim() || input.sessionPathToken.trim(),
      source: input.sessionPath,
    };
  }

  let best: (SessionCandidate & { match: boolean }) | undefined;
  for (const candidate of input.candidates) {
    if (!candidate.token) continue;
    const match = !url || !candidate.url || candidate.url === url;
    if (!best || (match && !best.match) || (match === best.match && candidate.mtimeMs > best.mtimeMs)) {
      best = { ...candidate, match };
    }
  }

  const resolvedUrl = url || best?.url || '';
  const configuredToken = input.configuredToken.trim();
  if (configuredToken) return { url: resolvedUrl, token: configuredToken, source: undefined };
  return { url: resolvedUrl, token: best?.token || '', source: best?.dir };
}

export interface CoderWorkspace {
  name: string;
  last_used_at?: string;
  latest_build?: { status?: string };
}

export type WorkspaceChoice =
  | { ok: true; name: string }
  | { ok: false; reason: 'no-workspace' | 'ambiguous'; names?: string[] };

/**
 * Choose a workspace when none is configured: an explicit env name wins, then a
 * sole workspace, then the only running one, then the most recently used one.
 */
export function chooseWorkspace(workspaces: readonly CoderWorkspace[], envName = ''): WorkspaceChoice {
  if (workspaces.length === 0) return { ok: false, reason: 'no-workspace' };
  if (envName && workspaces.some((w) => w.name === envName)) return { ok: true, name: envName };
  if (workspaces.length === 1) return { ok: true, name: workspaces[0].name };

  const running = workspaces.filter((w) => w.latest_build?.status === 'running');
  if (running.length === 1) return { ok: true, name: running[0].name };

  const byUse = [...workspaces].sort(
    (a, b) => (Date.parse(b.last_used_at || '') || 0) - (Date.parse(a.last_used_at || '') || 0),
  );
  if (byUse[0]?.last_used_at) return { ok: true, name: byUse[0].name };

  return { ok: false, reason: 'ambiguous', names: workspaces.map((w) => w.name) };
}

export interface CoderApp {
  slug: string;
  displayName?: string;
  url?: string;
}

export type AppChoice =
  | { ok: true; slug: string }
  | { ok: false; reason: 'no-app' | 'select-app'; slugs?: string[] };

export function pickAppSlug(apps: readonly CoderApp[], configured: string): AppChoice {
  const slug = configured.trim();
  if (slug) return { ok: true, slug };
  if (apps.length === 1) return { ok: true, slug: apps[0].slug };
  if (apps.length === 0) return { ok: false, reason: 'no-app' };
  return { ok: false, reason: 'select-app', slugs: apps.map((a) => a.slug) };
}

/** `slug[--agent]--workspace--owner.domain`, lower-cased like Coder maps it. */
export function coderAppHost(parts: { slug: string; agent?: string; workspace: string; owner: string; domain: string }): string {
  const labels = [parts.slug, parts.agent, parts.workspace, parts.owner]
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.toLowerCase());
  return `${labels.join('--')}.${parts.domain}`;
}

export function parseLaunchToken(html: string): string | null {
  const match = html.match(/location\.replace\(\s*["']\.\/\?token=([^"'&]+)/);
  return match ? match[1] : null;
}

/** Read the apps of a workspace build (`resources[].agents[].apps[]`). */
export function buildApps(build: unknown): CoderApp[] {
  const apps: CoderApp[] = [];
  const resources = (build as { resources?: unknown[] } | null)?.resources ?? [];
  for (const resource of resources) {
    const agents = (resource as { agents?: unknown[] } | null)?.agents ?? [];
    for (const agent of agents) {
      const list = (agent as { apps?: unknown[] } | null)?.apps ?? [];
      for (const app of list) {
        const record = app as { slug?: unknown; display_name?: unknown; url?: unknown };
        if (typeof record.slug === 'string') {
          apps.push({
            slug: record.slug,
            displayName: typeof record.display_name === 'string' ? record.display_name : undefined,
            url: typeof record.url === 'string' ? record.url : undefined,
          });
        }
      }
    }
  }
  return apps;
}

export interface CoderSettings {
  owner: string;
  workspace: string;
  appSlug: string;
  appDomain: string;
  agent: string;
}

export interface CoderTarget {
  ok: true;
  owner: string;
  workspace: string;
  workspaceId: string;
  buildId: string;
  status: string;
  appSlug: string;
  appHost: string;
  appUrl: string;
  /** App slugs found on the workspace when several are available. */
  candidates?: string[];
  deployment: CoderDeployment;
}

export interface CoderTargetError {
  ok: false;
  error: 'no-url' | 'no-token' | 'expired' | 'api' | 'no-workspace' | 'ambiguous' | 'no-domain';
  status?: number;
  owner?: string;
  workspace?: string;
  names?: string[];
}

export type CoderTargetResult = CoderTarget | CoderTargetError;

export type FetchLike = typeof fetch;

export function createCoderFetch(deployment: CoderDeployment, fetchImpl: FetchLike = fetch): FetchLike {
  return (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Coder-Session-Token', deployment.token);
    return fetchImpl(input, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(8000) });
  };
}

export async function listCoderApps(deployment: CoderDeployment, buildId: string, fetchImpl: FetchLike = fetch): Promise<CoderApp[]> {
  try {
    const response = await createCoderFetch(deployment, fetchImpl)(
      `${deployment.url}/api/v2/workspacebuilds/${encodeURIComponent(buildId)}`,
    );
    if (!response.ok) return [];
    return buildApps(await response.json());
  } catch {
    return [];
  }
}

/**
 * Resolve owner, workspace, app slug and the app URL, and report the workspace
 * status so the panel can offer to start a stopped one. A stopped workspace
 * exposes no apps, so `appSlug` stays empty until it runs or is configured.
 */
export async function resolveTarget(
  deployment: CoderDeployment,
  settings: CoderSettings,
  options: { envWorkspace?: string; fetchImpl?: FetchLike } = {},
): Promise<CoderTargetResult> {
  if (!deployment.url) return { ok: false, error: 'no-url' };
  if (!deployment.token) return { ok: false, error: 'no-token' };

  const api = createCoderFetch(deployment, options.fetchImpl ?? fetch);

  let owner = settings.owner.trim();
  if (!owner) {
    const response = await api(`${deployment.url}/api/v2/users/me`);
    if (response.status === 401) return { ok: false, error: 'expired' };
    if (!response.ok) return { ok: false, error: 'api', status: response.status };
    owner = ((await response.json()) as { username?: string }).username ?? '';
  }

  let workspace = settings.workspace.trim();
  if (!workspace) {
    const response = await api(`${deployment.url}/api/v2/workspaces?q=${encodeURIComponent('owner:' + owner)}`);
    if (response.status === 401) return { ok: false, error: 'expired' };
    if (!response.ok) return { ok: false, error: 'api', status: response.status };
    const list = ((await response.json()) as { workspaces?: CoderWorkspace[] }).workspaces ?? [];
    const choice = chooseWorkspace(list, options.envWorkspace ?? '');
    if (!choice.ok) return { ok: false, error: choice.reason, owner, names: choice.names };
    workspace = choice.name;
  }

  const response = await api(
    `${deployment.url}/api/v2/users/${encodeURIComponent(owner)}/workspace/${encodeURIComponent(workspace)}`,
  );
  if (response.status === 401) return { ok: false, error: 'expired' };
  if (!response.ok) return { ok: false, error: 'no-workspace', owner, workspace };
  const detail = (await response.json()) as { id?: string; latest_build?: { id?: string; status?: string } };
  const status = detail.latest_build?.status ?? 'unknown';
  const buildId = detail.latest_build?.id ?? '';

  let appSlug = settings.appSlug.trim();
  let candidates: string[] | undefined;
  if (!appSlug && status === 'running' && buildId) {
    const apps = await listCoderApps(deployment, buildId, options.fetchImpl ?? fetch);
    const picked = pickAppSlug(apps, '');
    if (picked.ok) appSlug = picked.slug;
    else candidates = picked.slugs ?? [];
  }

  const domain = settings.appDomain.trim() || hostnameOf(deployment.url);
  if (!domain) return { ok: false, error: 'no-domain' };
  const appHost = appSlug ? coderAppHost({ slug: appSlug, agent: settings.agent, workspace, owner, domain }) : '';

  return {
    ok: true,
    owner,
    workspace,
    workspaceId: detail.id ?? '',
    buildId,
    status,
    appSlug,
    appHost,
    appUrl: appHost ? `http://${appHost}` : '',
    candidates,
    deployment,
  };
}

export async function startWorkspace(deployment: CoderDeployment, workspaceId: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const response = await createCoderFetch(deployment, fetchImpl)(
    `${deployment.url}/api/v2/workspaces/${encodeURIComponent(workspaceId)}/builds`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transition: 'start' }) },
  );
  return response.ok;
}

export async function isAppReady(deployment: CoderDeployment, appUrl: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${appUrl}/`, {
      headers: { 'Coder-Session-Token': deployment.token },
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
