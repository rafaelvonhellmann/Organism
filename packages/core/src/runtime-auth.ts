import { spawnSync } from 'child_process';

export type PrAuthMode = 'token' | 'git-credentials' | 'gh' | 'none';
export type VercelAuthMode = 'token' | 'session' | 'none';

export interface GitHubRemote {
  owner: string;
  repo: string;
  remoteUrl: string;
}

export interface GitHubCredential {
  username: string;
  password: string;
}

export interface PrAuthStatus {
  ready: boolean;
  mode: PrAuthMode;
  ghCliAvailable: boolean;
  ghAuthReady: boolean;
  tokenPresent: boolean;
  credentialReady: boolean;
  remote: GitHubRemote | null;
  reason: string | null;
}

export interface VercelAuthStatus {
  ready: boolean;
  mode: VercelAuthMode;
  cliAvailable: boolean;
  tokenPresent: boolean;
  sessionReady: boolean;
  account: string | null;
  reason: string | null;
}

export interface PullRequestResult {
  created: boolean;
  number: number;
  url: string;
  mode: Exclude<PrAuthMode, 'none'>;
}

interface SyncResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface AuthDeps {
  commandExists: (command: string) => boolean;
  runSync: (command: string, args: string[], options?: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv }) => SyncResult;
  now: () => number;
}

interface PullRequestDeps {
  getPrAuthStatus: (repoPath: string | null, remoteUrl?: string | null) => PrAuthStatus;
  fetchFn: typeof fetch;
}

const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedGhAuth: { expiresAt: number; ready: boolean; available: boolean } | null = null;
let cachedVercelAuth: { expiresAt: number; status: VercelAuthStatus } | null = null;
const cachedCredentialStatus = new Map<string, { expiresAt: number; status: PrAuthStatus }>();

export function resetRuntimeAuthCaches(): void {
  cachedGhAuth = null;
  cachedVercelAuth = null;
  cachedCredentialStatus.clear();
}

function resolveCommandBinary(command: string): string {
  if (process.platform !== 'win32' || /\.[a-z0-9]+$/i.test(command)) {
    return command;
  }
  const cmdShim = `${command}.cmd`;
  const result = spawnSync('where.exe', [cmdShim], { stdio: 'ignore', windowsHide: true });
  return result.status === 0 ? cmdShim : command;
}

function quoteCmdArg(value: string): string {
  return /[\s"&|<>^]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

function defaultCommandExists(command: string): boolean {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}

function defaultRunSync(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
): SyncResult {
  try {
    const binary = resolveCommandBinary(command);
    const result = process.platform === 'win32' && binary.endsWith('.cmd')
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', `${binary} ${args.map(quoteCmdArg).join(' ')}`.trim()], {
        cwd: options.cwd,
        input: options.input,
        env: options.env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      : spawnSync(binary, args, {
        cwd: options.cwd,
        input: options.input,
        env: options.env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    return {
      status: result.status,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
    };
  } catch (error) {
    return {
      status: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function defaultDeps(): AuthDeps {
  return {
    commandExists: defaultCommandExists,
    runSync: defaultRunSync,
    now: () => Date.now(),
  };
}

export function parseGitHubRemote(remoteUrl: string | null): GitHubRemote | null {
  if (!remoteUrl) return null;

  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
      remoteUrl,
    };
  }

  const sshMatch = remoteUrl.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
      remoteUrl,
    };
  }

  return null;
}

function gitHubToken(): string | null {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
}

function ghCliStatus(deps: AuthDeps): { available: boolean; ready: boolean } {
  const now = deps.now();
  if (cachedGhAuth && cachedGhAuth.expiresAt > now) {
    return {
      available: cachedGhAuth.available,
      ready: cachedGhAuth.ready,
    };
  }

  const available = deps.commandExists('gh');
  const ready = available
    ? deps.runSync('gh', ['auth', 'status']).status === 0
    : false;

  cachedGhAuth = {
    expiresAt: now + AUTH_CACHE_TTL_MS,
    available,
    ready,
  };

  return { available, ready };
}

function parseCredentialOutput(output: string): GitHubCredential | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fields = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }

  const username = fields.get('username');
  const password = fields.get('password');
  if (!username || !password) return null;

  return { username, password };
}

export function getGitHubCredential(remote: GitHubRemote, deps = defaultDeps()): GitHubCredential | null {
  const request = `protocol=https\nhost=github.com\npath=${remote.owner}/${remote.repo}.git\n\n`;
  const result = deps.runSync('git', ['credential', 'fill'], { input: request });
  if (result.status !== 0) return null;
  return parseCredentialOutput(result.stdout);
}

export function getPrAuthStatus(repoPath: string | null, remoteUrl?: string | null, deps = defaultDeps()): PrAuthStatus {
  const remote = parseGitHubRemote(
    remoteUrl
    ?? (repoPath ? deps.runSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath }).stdout || null : null),
  );

  const tokenPresent = Boolean(gitHubToken());
  const gh = ghCliStatus(deps);
  const cacheKey = remote?.remoteUrl ?? '__no-remote__';
  const cached = cachedCredentialStatus.get(cacheKey);
  const now = deps.now();
  if (cached && cached.expiresAt > now && cached.status.remote?.remoteUrl === remote?.remoteUrl && cached.status.tokenPresent === tokenPresent) {
    return {
      ...cached.status,
      ghCliAvailable: gh.available,
      ghAuthReady: gh.ready,
      tokenPresent,
    };
  }

  const credentialReady = remote ? Boolean(getGitHubCredential(remote, deps)) : false;

  let status: PrAuthStatus;
  if (!remote) {
    status = {
      ready: false,
      mode: 'none',
      ghCliAvailable: gh.available,
      ghAuthReady: gh.ready,
      tokenPresent,
      credentialReady: false,
      remote: null,
      reason: 'GitHub remote could not be resolved for PR creation.',
    };
  } else if (tokenPresent) {
    status = {
      ready: true,
      mode: 'token',
      ghCliAvailable: gh.available,
      ghAuthReady: gh.ready,
      tokenPresent,
      credentialReady,
      remote,
      reason: null,
    };
  } else if (credentialReady) {
    status = {
      ready: true,
      mode: 'git-credentials',
      ghCliAvailable: gh.available,
      ghAuthReady: gh.ready,
      tokenPresent,
      credentialReady,
      remote,
      reason: null,
    };
  } else if (gh.ready) {
    status = {
      ready: true,
      mode: 'gh',
      ghCliAvailable: gh.available,
      ghAuthReady: gh.ready,
      tokenPresent,
      credentialReady,
      remote,
      reason: null,
    };
  } else {
    status = {
      ready: false,
      mode: 'none',
      ghCliAvailable: gh.available,
      ghAuthReady: gh.ready,
      tokenPresent,
      credentialReady,
      remote,
      reason: 'No non-interactive GitHub credential is available for PR creation.',
    };
  }

  cachedCredentialStatus.set(cacheKey, {
    expiresAt: now + AUTH_CACHE_TTL_MS,
    status,
  });
  return status;
}

function vercelWhoAmI(deps: AuthDeps): { ready: boolean; account: string | null; cliAvailable: boolean } {
  const directCli = deps.commandExists('vercel');
  if (directCli) {
    const direct = deps.runSync('vercel', ['whoami']);
    if (direct.status === 0) {
      return {
        ready: true,
        account: direct.stdout.split(/\r?\n/).find(Boolean) ?? null,
        cliAvailable: true,
      };
    }
  }

  const npxAvailable = deps.commandExists('npx');
  if (!npxAvailable) {
    return { ready: false, account: null, cliAvailable: directCli };
  }

  const npx = deps.runSync('npx', ['--yes', 'vercel@latest', 'whoami']);
  return {
    ready: npx.status === 0,
    account: npx.status === 0 ? (npx.stdout.split(/\r?\n/).find(Boolean) ?? null) : null,
    cliAvailable: directCli || npx.status === 0,
  };
}

export function getVercelAuthStatus(deps = defaultDeps()): VercelAuthStatus {
  const now = deps.now();
  if (cachedVercelAuth && cachedVercelAuth.expiresAt > now) {
    return cachedVercelAuth.status;
  }

  const tokenPresent = Boolean(process.env.VERCEL_TOKEN || process.env.VERCEL_ACCESS_TOKEN);
  if (tokenPresent) {
    const status: VercelAuthStatus = {
      ready: true,
      mode: 'token',
      cliAvailable: deps.commandExists('vercel') || deps.commandExists('npx'),
      tokenPresent: true,
      sessionReady: false,
      account: null,
      reason: null,
    };
    cachedVercelAuth = { expiresAt: now + AUTH_CACHE_TTL_MS, status };
    return status;
  }

  const session = vercelWhoAmI(deps);
  const status: VercelAuthStatus = session.ready
    ? {
      ready: true,
      mode: 'session',
      cliAvailable: session.cliAvailable,
      tokenPresent: false,
      sessionReady: true,
      account: session.account,
      reason: null,
    }
    : {
      ready: false,
      mode: 'none',
      cliAvailable: session.cliAvailable,
      tokenPresent: false,
      sessionReady: false,
      account: null,
      reason: 'No non-interactive Vercel token or local Vercel session is available.',
    };

  cachedVercelAuth = { expiresAt: now + AUTH_CACHE_TTL_MS, status };
  return status;
}

async function githubApiRequest<T>(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch,
): Promise<T> {
  const response = await fetchFn(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 400)}`);
  }
  return response.json() as Promise<T>;
}

function createGhCliPullRequest(params: {
  repoPath: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}): PullRequestResult {
  const args = [
    'pr',
    'create',
    '--title', params.title,
    '--body', params.body,
    '--base', params.baseBranch,
    '--head', params.branchName,
  ];
  if (params.draft) {
    args.push('--draft');
  }

  const created = defaultRunSync('gh', args, { cwd: params.repoPath });
  if (created.status === 0) {
    const url = created.stdout.split(/\r?\n/).find((line) => /^https:\/\/github\.com\//i.test(line)) ?? created.stdout;
    const numberMatch = url.match(/\/pull\/(\d+)/);
    return {
      created: true,
      number: numberMatch ? Number(numberMatch[1]) : 0,
      url,
      mode: 'gh',
    };
  }

  if (!/already exists/i.test(created.stderr) && !/already exists/i.test(created.stdout)) {
    throw new Error(`gh PR create failed: ${(created.stderr || created.stdout || 'unknown error').slice(0, 400)}`);
  }

  const view = defaultRunSync('gh', ['pr', 'view', params.branchName, '--json', 'number,url'], { cwd: params.repoPath });
  if (view.status !== 0) {
    throw new Error(`gh PR view failed: ${(view.stderr || view.stdout || 'unknown error').slice(0, 400)}`);
  }

  const parsed = JSON.parse(view.stdout) as { number?: number; url?: string };
  if (!parsed.number || !parsed.url) {
    throw new Error('gh PR view did not return a number and url.');
  }

  return {
    created: false,
    number: parsed.number,
    url: parsed.url,
    mode: 'gh',
  };
}

export async function createGitHubPullRequest(
  params: {
    repoPath: string;
    remoteUrl?: string | null;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
    draft?: boolean;
  },
  deps: PullRequestDeps = {
    getPrAuthStatus: (repoPath, remoteUrl) => getPrAuthStatus(repoPath, remoteUrl),
    fetchFn: fetch,
  },
): Promise<PullRequestResult> {
  const auth = deps.getPrAuthStatus(params.repoPath, params.remoteUrl);
  if (!auth.ready || !auth.remote || auth.mode === 'none') {
    throw new Error(auth.reason ?? 'GitHub PR creation is not ready.');
  }

  if (auth.mode === 'gh') {
    return createGhCliPullRequest(params);
  }

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'organism-v2-controller',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (auth.mode === 'token') {
    headers.Authorization = `Bearer ${gitHubToken()}`;
  } else {
    const credential = getGitHubCredential(auth.remote);
    if (!credential) {
      throw new Error('GitHub credential lookup failed for pull request creation.');
    }
    headers.Authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`;
  }

  const repoPath = `${auth.remote.owner}/${auth.remote.repo}`;
  const existingUrl = new URL(`https://api.github.com/repos/${repoPath}/pulls`);
  existingUrl.searchParams.set('state', 'open');
  existingUrl.searchParams.set('head', `${auth.remote.owner}:${params.branchName}`);
  existingUrl.searchParams.set('base', params.baseBranch);

  const existing = await githubApiRequest<Array<{ number: number; html_url: string }>>(
    existingUrl.toString(),
    { method: 'GET', headers },
    deps.fetchFn,
  );

  if (existing.length > 0) {
    return {
      created: false,
      number: existing[0].number,
      url: existing[0].html_url,
      mode: auth.mode,
    };
  }

  const created = await githubApiRequest<{ number: number; html_url: string }>(
    `https://api.github.com/repos/${repoPath}/pulls`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: params.title,
        body: params.body,
        head: params.branchName,
        base: params.baseBranch,
        draft: params.draft ?? false,
      }),
    },
    deps.fetchFn,
  );

  return {
    created: true,
    number: created.number,
    url: created.html_url,
    mode: auth.mode,
  };
}
