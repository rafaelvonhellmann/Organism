import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { loadProjectPolicy } from '../packages/core/src/project-policy.js';
import { STATE_DIR } from '../packages/shared/src/state-dir.js';

interface WorktreeEntry {
  worktree: string;
  head: string;
  branch: string | null;
  detached: boolean;
}

interface CleanupRow {
  path: string;
  kind: 'worktree' | 'orphan';
  action: 'would_delete' | 'deleted' | 'skipped' | 'failed';
  reason: string;
  dirtyCount: number;
  stashRef?: string;
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function tryRunGit(args: string[], cwd: string): string {
  try {
    return runGit(args, cwd);
  } catch {
    return '';
  }
}

function getArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'worktree';
}

function shortProjectToken(projectId: string): string {
  const compact = slugify(projectId).replace(/-/g, '').slice(0, 10);
  if (compact.length >= 4) return compact;
  return crypto.createHash('sha1').update(projectId).digest('hex').slice(0, 10);
}

function resolveExisting(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseWorktrees(repoPath: string): WorktreeEntry[] {
  const output = runGit(['worktree', 'list', '--porcelain'], repoPath);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = {
        worktree: line.slice('worktree '.length),
        head: '',
        branch: null,
        detached: false,
      };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line === 'detached') {
      current.detached = true;
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }

  if (current) entries.push(current);
  return entries;
}

function statusCount(worktreePath: string): number {
  const output = tryRunGit(['status', '--porcelain'], worktreePath);
  if (!output) return 0;
  return output.split(/\r?\n/).filter(Boolean).length;
}

function createAndVerifyBundle(repoPath: string, cleanupDir: string): string {
  const bundlePath = path.join(cleanupDir, 'all-refs-before-worktree-janitor.bundle');
  runGit(['bundle', 'create', bundlePath, '--all'], repoPath);
  runGit(['bundle', 'verify', bundlePath], repoPath);
  return bundlePath;
}

function stashDirty(worktreePath: string, label: string): string | undefined {
  if (statusCount(worktreePath) === 0) return undefined;
  runGit(['stash', 'push', '-u', '-m', label], worktreePath);
  return tryRunGit(['stash', 'list', '--format=%gd|%H|%gs', '-n', '1'], worktreePath) || undefined;
}

function removeGitWorktree(repoPath: string, worktreePath: string): { ok: boolean; reason: string } {
  try {
    runGit(['worktree', 'remove', '--force', worktreePath], repoPath);
    return { ok: true, reason: 'git worktree remove --force succeeded' };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function worktreeRoots(projectId: string): string[] {
  return [
    path.join(STATE_DIR, 'wt', shortProjectToken(projectId)),
    path.join(STATE_DIR, 'worktrees', projectId),
  ].map((root) => path.resolve(root));
}

function listOrphanDirectories(projectId: string, liveWorktreePaths: Set<string>): string[] {
  const roots = worktreeRoots(projectId);
  const orphans: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(root, entry.name);
      const resolved = resolveExisting(fullPath) ?? path.resolve(fullPath);
      if (liveWorktreePaths.has(resolved)) continue;
      if (fs.existsSync(path.join(resolved, '.git'))) continue;
      orphans.push(resolved);
    }
  }
  return orphans;
}

function printUsage(): void {
  console.log(`Usage: npm run worktree-janitor -- [options]

Options:
  --project <id>                  Project policy to use. Defaults to organism.
  --repo <path>                   Override policy repoPath.
  --apply                         Actually stash/delete. Without this, dry-run only.
  --include-branch-worktrees      Also clean non-detached state worktrees.
  --no-orphans                    Skip orphan state directory cleanup.

The janitor only deletes paths under ${STATE_DIR}. It writes a verified git
bundle before any --apply cleanup.`);
}

async function main(): Promise<void> {
  if (hasFlag('--help') || hasFlag('-h')) {
    printUsage();
    return;
  }

  const projectId = getArg('--project') ?? 'organism';
  const policy = loadProjectPolicy(projectId);
  const repoPath = path.resolve(getArg('--repo') ?? policy.repoPath ?? '');
  const apply = hasFlag('--apply');
  const includeBranchWorktrees = hasFlag('--include-branch-worktrees');
  const includeOrphans = !hasFlag('--no-orphans');
  const resolvedStateDir = path.resolve(STATE_DIR);

  if (!repoPath || !fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`Repo path is not a git repository: ${repoPath || '(empty)'}`);
  }

  const cleanupDir = path.join(STATE_DIR, 'branch-cleanup', timestamp());
  fs.mkdirSync(cleanupDir, { recursive: true });

  const worktrees = parseWorktrees(repoPath);
  const liveWorktreePaths = new Set(
    worktrees
      .map((entry) => resolveExisting(entry.worktree) ?? path.resolve(entry.worktree))
      .filter(Boolean),
  );
  const repoRealPath = resolveExisting(repoPath) ?? path.resolve(repoPath);

  const candidates = worktrees.filter((entry) => {
    const resolved = resolveExisting(entry.worktree) ?? path.resolve(entry.worktree);
    if (resolved === repoRealPath) return false;
    if (!isInside(resolvedStateDir, resolved)) return false;
    return entry.detached || includeBranchWorktrees;
  });
  const orphans = includeOrphans ? listOrphanDirectories(projectId, liveWorktreePaths) : [];

  fs.writeFileSync(
    path.join(cleanupDir, 'worktree-janitor-inventory.json'),
    JSON.stringify({ projectId, repoPath, apply, candidates, orphans }, null, 2),
  );

  let bundlePath: string | null = null;
  if (apply && (candidates.length > 0 || orphans.length > 0)) {
    bundlePath = createAndVerifyBundle(repoPath, cleanupDir);
  }

  const rows: CleanupRow[] = [];
  for (const entry of candidates) {
    const resolved = resolveExisting(entry.worktree) ?? path.resolve(entry.worktree);
    if (!isInside(resolvedStateDir, resolved)) {
      rows.push({ path: resolved, kind: 'worktree', action: 'skipped', reason: 'outside state dir', dirtyCount: 0 });
      continue;
    }
    const dirtyCount = statusCount(resolved);
    if (!apply) {
      rows.push({
        path: resolved,
        kind: 'worktree',
        action: 'would_delete',
        reason: entry.detached ? 'detached state worktree' : 'state worktree included by flag',
        dirtyCount,
      });
      continue;
    }

    const stashRef = stashDirty(resolved, `[worktree-janitor ${path.basename(cleanupDir)}] ${resolved}`);
    const remainingDirty = statusCount(resolved);
    if (remainingDirty > 0) {
      rows.push({
        path: resolved,
        kind: 'worktree',
        action: 'skipped',
        reason: `stash left ${remainingDirty} dirty entr${remainingDirty === 1 ? 'y' : 'ies'}`,
        dirtyCount,
        stashRef,
      });
      continue;
    }

    const removal = removeGitWorktree(repoPath, resolved);
    rows.push({
      path: resolved,
      kind: 'worktree',
      action: removal.ok ? 'deleted' : 'failed',
      reason: removal.reason,
      dirtyCount,
      stashRef,
    });
  }

  for (const orphan of orphans) {
    if (!isInside(resolvedStateDir, orphan)) {
      rows.push({ path: orphan, kind: 'orphan', action: 'skipped', reason: 'outside state dir', dirtyCount: 0 });
      continue;
    }
    if (!apply) {
      rows.push({ path: orphan, kind: 'orphan', action: 'would_delete', reason: 'orphan state directory', dirtyCount: 0 });
      continue;
    }
    fs.rmSync(orphan, { recursive: true, force: true });
    rows.push({
      path: orphan,
      kind: 'orphan',
      action: fs.existsSync(orphan) ? 'failed' : 'deleted',
      reason: 'orphan state directory',
      dirtyCount: 0,
    });
  }

  if (apply) {
    tryRunGit(['worktree', 'prune', '--verbose'], repoPath);
  }

  const reportPath = path.join(cleanupDir, 'worktree-janitor-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ projectId, repoPath, apply, bundlePath, rows }, null, 2));

  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.action] = (acc[row.action] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Project: ${projectId}`);
  console.log(`Repo: ${repoPath}`);
  console.log(`Mode: ${apply ? 'apply' : 'dry-run'}`);
  if (bundlePath) console.log(`Bundle: ${bundlePath}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Counts: ${JSON.stringify(counts)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
