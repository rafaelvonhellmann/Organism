import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type UpstreamSourceConfig = {
  id: string;
  label: string;
  kind: string;
  repo?: string | null;
  localTargets?: string[];
  lastReviewedAt?: string | null;
  lastAdoptedVersion?: string | null;
  notes?: string | null;
};

type UpstreamRegistry = {
  sources?: UpstreamSourceConfig[];
};

type GitHubSnapshot = {
  pushedAt: string | null;
  latestReleaseTag: string | null;
  latestReleasePublishedAt: string | null;
  stars: number | null;
  openIssues: number | null;
  homepage: string | null;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const sourceCache = new Map<string, { expiresAt: number; value: GitHubSnapshot | null }>();

function workspacePath(...segments: string[]): string {
  const direct = resolve(process.cwd(), ...segments);
  if (existsSync(direct)) return direct;
  return resolve(process.cwd(), '..', '..', ...segments);
}

function safeDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readRegistry(): UpstreamSourceConfig[] {
  const path = workspacePath('knowledge', 'upstream-sources.json');
  if (!existsSync(path)) return [];

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as UpstreamRegistry;
    return Array.isArray(raw.sources) ? raw.sources : [];
  } catch {
    return [];
  }
}

async function fetchGitHubSnapshot(repo: string): Promise<GitHubSnapshot | null> {
  const now = Date.now();
  const cached = sourceCache.get(repo);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const headers: HeadersInit = {
    'User-Agent': 'organism-dashboard-v2',
    Accept: 'application/vnd.github+json',
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const [repoRes, releaseRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}`, { headers, cache: 'no-store' }),
      fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers, cache: 'no-store' }),
    ]);

    if (!repoRes.ok) {
      sourceCache.set(repo, { expiresAt: now + CACHE_TTL_MS, value: null });
      return null;
    }

    const repoJson = await repoRes.json() as {
      pushed_at?: string | null;
      stargazers_count?: number | null;
      open_issues_count?: number | null;
      homepage?: string | null;
    };

    let latestReleaseTag: string | null = null;
    let latestReleasePublishedAt: string | null = null;
    if (releaseRes.ok) {
      const releaseJson = await releaseRes.json() as {
        tag_name?: string | null;
        published_at?: string | null;
      };
      latestReleaseTag = releaseJson.tag_name ?? null;
      latestReleasePublishedAt = releaseJson.published_at ?? null;
    }

    const snapshot = {
      pushedAt: repoJson.pushed_at ?? null,
      latestReleaseTag,
      latestReleasePublishedAt,
      stars: repoJson.stargazers_count ?? null,
      openIssues: repoJson.open_issues_count ?? null,
      homepage: repoJson.homepage ?? null,
    };
    sourceCache.set(repo, { expiresAt: now + CACHE_TTL_MS, value: snapshot });
    return snapshot;
  } catch {
    sourceCache.set(repo, { expiresAt: now + CACHE_TTL_MS, value: null });
    return null;
  }
}

function deriveStatus(config: UpstreamSourceConfig, snapshot: GitHubSnapshot | null) {
  if (!config.repo) return 'manual_only';
  if (!snapshot) return 'unavailable';

  if (config.lastAdoptedVersion && snapshot.latestReleaseTag && snapshot.latestReleaseTag !== config.lastAdoptedVersion) {
    return 'needs_review';
  }

  const pushedAt = safeDate(snapshot.pushedAt);
  const reviewedAt = safeDate(config.lastReviewedAt);
  if (pushedAt && (!reviewedAt || pushedAt > reviewedAt)) {
    return 'recent_activity';
  }

  return 'up_to_date';
}

export async function getUpstreamSources() {
  const configs = readRegistry();
  const checkedAt = new Date().toISOString();

  return Promise.all(configs.map(async (config) => {
    const snapshot = config.repo ? await fetchGitHubSnapshot(config.repo) : null;
    return {
      id: config.id,
      label: config.label,
      kind: config.kind,
      repo: config.repo ?? null,
      localTargets: Array.isArray(config.localTargets) ? config.localTargets : [],
      lastReviewedAt: config.lastReviewedAt ?? null,
      lastAdoptedVersion: config.lastAdoptedVersion ?? null,
      notes: config.notes ?? null,
      checkedAt,
      upstreamPushedAt: snapshot?.pushedAt ?? null,
      latestReleaseTag: snapshot?.latestReleaseTag ?? null,
      latestReleasePublishedAt: snapshot?.latestReleasePublishedAt ?? null,
      stars: snapshot?.stars ?? null,
      openIssues: snapshot?.openIssues ?? null,
      homepage: snapshot?.homepage ?? null,
      status: deriveStatus(config, snapshot),
    };
  }));
}

export default {
  getUpstreamSources,
};
