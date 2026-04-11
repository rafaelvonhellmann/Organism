import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { loadProjectPolicy } from './project-policy.js';

export interface RepoReviewFileExcerpt {
  path: string;
  content: string;
}

export interface RepoReviewBrief {
  projectId: string;
  repoPath: string | null;
  defaultBranch: string;
  branch: string | null;
  dirty: boolean;
  topLevelEntries: string[];
  changedFiles: string[];
  recentCommits: string[];
  fileExcerpts: RepoReviewFileExcerpt[];
  tasklist: string | null;
}

const IGNORED_TOP_LEVEL = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.vercel',
]);

function tryGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function safeRead(filePath: string, maxChars: number): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.slice(0, maxChars);
  } catch {
    return null;
  }
}

function readTasklist(tasklistPath: string | undefined, maxChars: number): string | null {
  if (!tasklistPath) return null;
  return safeRead(tasklistPath, maxChars);
}

function collectTopLevelEntries(repoPath: string): string[] {
  try {
    return fs.readdirSync(repoPath, { withFileTypes: true })
      .filter((entry) => !IGNORED_TOP_LEVEL.has(entry.name))
      .map((entry) => `${entry.isDirectory() ? 'dir' : 'file'}:${entry.name}`)
      .slice(0, 30);
  } catch {
    return [];
  }
}

function collectChangedFiles(repoPath: string): string[] {
  const status = tryGit(['status', '--porcelain'], repoPath);
  if (!status) return [];
  return status
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => line.slice(3).trimStart())
    .slice(0, 20);
}

function collectRecentCommits(repoPath: string): string[] {
  const log = tryGit(['log', '--oneline', '-5'], repoPath);
  if (!log) return [];
  return log.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function collectFileExcerpts(repoPath: string, maxChars: number, tasklistPath?: string): RepoReviewFileExcerpt[] {
  const candidates = [
    'README.md',
    'package.json',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'next.config.ts',
    'next.config.js',
    'CLAUDE.md',
    'AGENTS.md',
  ];

  const excerpts: RepoReviewFileExcerpt[] = [];
  for (const candidate of candidates) {
    const fullPath = path.join(repoPath, candidate);
    const content = safeRead(fullPath, maxChars);
    if (!content) continue;
    excerpts.push({ path: candidate, content });
  }

  if (tasklistPath) {
    const tasklistContent = safeRead(tasklistPath, maxChars);
    if (tasklistContent) {
      excerpts.push({
        path: path.relative(repoPath, tasklistPath).replace(/\\/g, '/'),
        content: tasklistContent,
      });
    }
  }

  return excerpts.slice(0, 8);
}

export function buildRepoReviewBrief(projectId: string, maxCharsPerFile = 3000): RepoReviewBrief {
  const policy = loadProjectPolicy(projectId);
  const repoPath = policy.repoPath;

  if (!repoPath || !fs.existsSync(repoPath)) {
    return {
      projectId,
      repoPath,
      defaultBranch: policy.defaultBranch,
      branch: null,
      dirty: false,
      topLevelEntries: [],
      changedFiles: [],
      recentCommits: [],
      fileExcerpts: [],
      tasklist: null,
    };
  }

  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath) || null;
  const changedFiles = collectChangedFiles(repoPath);
  const tasklistPath = (() => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'knowledge', 'projects', projectId, 'config.json'), 'utf8')) as { tasklist?: string };
      return raw.tasklist;
    } catch {
      return undefined;
    }
  })();

  return {
    projectId,
    repoPath,
    defaultBranch: policy.defaultBranch,
    branch,
    dirty: changedFiles.length > 0,
    topLevelEntries: collectTopLevelEntries(repoPath),
    changedFiles,
    recentCommits: collectRecentCommits(repoPath),
    fileExcerpts: collectFileExcerpts(repoPath, maxCharsPerFile, tasklistPath),
    tasklist: readTasklist(tasklistPath, maxCharsPerFile),
  };
}
