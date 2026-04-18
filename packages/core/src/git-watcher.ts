import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { listProjectPolicies } from './project-policy.js';
import { STATE_DIR } from '../../shared/src/state-dir.js';

// Track last seen commit per project
const LAST_COMMIT_FILE = path.join(STATE_DIR, 'git-last-commit.json');

interface ProjectRepo {
  projectId: string;
  repoPath: string;
}

function getProjectRepos(): ProjectRepo[] {
  return listProjectPolicies()
    .filter((policy) => policy.repoPath)
    .map((policy) => ({
      projectId: policy.projectId,
      repoPath: policy.repoPath!,
    }));
}

function loadLastCommits(): Record<string, string> {
  try {
    if (fs.existsSync(LAST_COMMIT_FILE)) {
      return JSON.parse(fs.readFileSync(LAST_COMMIT_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveLastCommits(commits: Record<string, string>): void {
  const dir = path.dirname(LAST_COMMIT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LAST_COMMIT_FILE, JSON.stringify(commits, null, 2));
}

function getLatestCommit(repoPath: string): { hash: string; message: string; files: string[] } | null {
  try {
    if (!fs.existsSync(repoPath)) return null;
    const execOpts = { cwd: repoPath, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], windowsHide: true };
    const hash = execSync('git rev-parse HEAD', execOpts).trim();
    const message = execSync('git log -1 --format=%s', execOpts).trim();
    const files = execSync('git diff --name-only HEAD~1 HEAD', execOpts).trim().split('\n').filter(Boolean);
    return { hash, message, files };
  } catch {
    return null;
  }
}

/**
 * Check all project repos for new commits.
 * Returns projects that have new commits since last check.
 */
export function checkForNewCommits(): Array<{ projectId: string; commit: string; message: string; changedFiles: string[] }> {
  const lastCommits = loadLastCommits();
  const newCommits: Array<{ projectId: string; commit: string; message: string; changedFiles: string[] }> = [];

  for (const repo of getProjectRepos()) {
    const latest = getLatestCommit(repo.repoPath);
    if (!latest) continue;

    const lastSeen = lastCommits[repo.projectId];
    if (!lastSeen) {
      lastCommits[repo.projectId] = latest.hash;
      continue;
    }
    if (lastSeen !== latest.hash) {
      newCommits.push({
        projectId: repo.projectId,
        commit: latest.hash,
        message: latest.message,
        changedFiles: latest.files,
      });
      lastCommits[repo.projectId] = latest.hash;
    }
  }

  if (newCommits.length > 0) {
    saveLastCommits(lastCommits);
  }

  return newCommits;
}

/**
 * Determine which agents should review based on changed files.
 */
export function agentsForChangedFiles(files: string[]): string[] {
  const agents = new Set<string>();

  for (const file of files) {
    const lower = file.toLowerCase();
    if (lower.includes('auth') || lower.includes('middleware') || lower.includes('security')) agents.add('security-audit');
    if (lower.includes('component') || lower.includes('.tsx') || lower.includes('.jsx') || lower.includes('page')) agents.add('engineering');
    if (lower.includes('api') || lower.includes('route') || lower.includes('server')) agents.add('engineering');
    if (lower.includes('test') || lower.includes('spec') || lower.includes('.test.')) agents.add('quality-guardian');
    if (lower.includes('package.json') || lower.includes('config') || lower.includes('.env')) agents.add('devops');
    if (lower.includes('prisma') || lower.includes('migration') || lower.includes('schema') || lower.includes('supabase')) agents.add('engineering');
    if (lower.includes('stripe') || lower.includes('billing') || lower.includes('payment')) agents.add('cfo');
    if (lower.includes('legal') || lower.includes('terms') || lower.includes('privacy') || lower.includes('license')) agents.add('legal');
  }

  // Always include engineering for any code changes
  if (files.some(f => f.match(/\.(ts|tsx|js|jsx|py|sql)$/))) {
    agents.add('engineering');
  }

  return [...agents];
}
