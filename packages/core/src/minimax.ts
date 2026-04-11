import { execFileSync, spawnSync } from 'child_process';
import { getSecretOrNull } from '../../shared/src/secrets.js';
import { MiniMaxCommand, ProjectPolicy } from '../../shared/src/types.js';

export interface MiniMaxStatus {
  enabled: boolean;
  cliAvailable: boolean;
  apiKeyPresent: boolean;
  authenticated: boolean;
  ready: boolean;
  region: 'global' | 'cn';
  authMode: 'auto' | 'api-key' | 'session';
  allowedCommands: MiniMaxCommand[];
  reason: string | null;
}

export interface MiniMaxSearchResult {
  query: string;
  raw: string;
  structured: unknown;
  summary: string;
}

function commandExists(command: string): boolean {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function mmxEnv(region: 'global' | 'cn', apiKey?: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (apiKey) env.MINIMAX_API_KEY = apiKey;
  env.MINIMAX_REGION = region;
  return env;
}

function authStatus(region: 'global' | 'cn', apiKey?: string | null): boolean {
  try {
    const result = spawnSync('mmx', ['auth', 'status'], {
      encoding: 'utf8',
      stdio: 'ignore',
      windowsHide: true,
      env: mmxEnv(region, apiKey),
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function ensureApiKeyAuth(region: 'global' | 'cn', apiKey: string): boolean {
  try {
    execFileSync('mmx', ['auth', 'login', '--api-key', apiKey], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: mmxEnv(region, apiKey),
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function getMiniMaxStatus(policy: ProjectPolicy): MiniMaxStatus {
  const config = policy.toolProviders.minimax;
  const apiKey = getSecretOrNull('MINIMAX_API_KEY');
  const cliAvailable = commandExists('mmx');
  const apiKeyPresent = Boolean(apiKey);

  if (!config.enabled) {
    return {
      enabled: false,
      cliAvailable,
      apiKeyPresent,
      authenticated: false,
      ready: false,
      region: config.region,
      authMode: config.authMode,
      allowedCommands: config.allowedCommands,
      reason: 'MiniMax is disabled for this project.',
    };
  }

  if (!cliAvailable) {
    return {
      enabled: true,
      cliAvailable: false,
      apiKeyPresent,
      authenticated: false,
      ready: false,
      region: config.region,
      authMode: config.authMode,
      allowedCommands: config.allowedCommands,
      reason: 'MiniMax CLI (mmx) is not available on PATH.',
    };
  }

  let authenticated = authStatus(config.region, apiKey);
  if (!authenticated && apiKeyPresent && config.authMode !== 'session') {
    authenticated = ensureApiKeyAuth(config.region, apiKey as string) && authStatus(config.region, apiKey);
  }

  return {
    enabled: true,
    cliAvailable,
    apiKeyPresent,
    authenticated,
    ready: authenticated,
    region: config.region,
    authMode: config.authMode,
    allowedCommands: config.allowedCommands,
    reason: authenticated
      ? null
      : apiKeyPresent
        ? 'MiniMax CLI is installed but authentication is not ready.'
        : 'MiniMax requires either MINIMAX_API_KEY or an existing mmx auth session.',
  };
}

function ensureCommandAllowed(status: MiniMaxStatus, command: MiniMaxCommand): void {
  if (!status.enabled) {
    throw new Error('MiniMax is not enabled for this project.');
  }
  if (!status.ready) {
    throw new Error(status.reason ?? 'MiniMax is not ready.');
  }
  if (!status.allowedCommands.includes(command)) {
    throw new Error(`MiniMax command "${command}" is not allowed by project policy.`);
  }
}

function summarizeSearchPayload(structured: unknown, fallback: string): string {
  if (Array.isArray(structured)) {
    return structured
      .slice(0, 8)
      .map((row) => {
        if (!row || typeof row !== 'object') return '';
        const record = row as Record<string, unknown>;
        const title = typeof record.title === 'string' ? record.title : 'Untitled result';
        const url = typeof record.url === 'string' ? record.url : typeof record.link === 'string' ? record.link : '';
        const snippet = typeof record.snippet === 'string'
          ? record.snippet
          : typeof record.description === 'string'
            ? record.description
            : '';
        return `- ${title}${url ? ` — ${url}` : ''}${snippet ? `\n  ${snippet}` : ''}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  if (structured && typeof structured === 'object') {
    const record = structured as Record<string, unknown>;
    for (const key of ['results', 'items', 'data']) {
      if (Array.isArray(record[key])) {
        return summarizeSearchPayload(record[key], fallback);
      }
    }
  }

  return fallback.trim();
}

export function runMiniMaxSearch(policy: ProjectPolicy, query: string): MiniMaxSearchResult {
  const status = getMiniMaxStatus(policy);
  ensureCommandAllowed(status, 'search');

  const apiKey = getSecretOrNull('MINIMAX_API_KEY');
  const raw = execFileSync('mmx', ['search', 'query', '--q', query, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: mmxEnv(status.region, apiKey),
    timeout: 60_000,
  }).trim();

  let structured: unknown = raw;
  try {
    structured = JSON.parse(raw);
  } catch {
    structured = raw;
  }

  return {
    query,
    raw,
    structured,
    summary: summarizeSearchPayload(structured, raw),
  };
}
