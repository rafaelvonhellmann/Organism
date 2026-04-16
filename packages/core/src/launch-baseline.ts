import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getProjectAutonomyHealth } from './autonomy-governor.js';
import { getProjectLaunchReadiness } from './project-readiness.js';
import { STATE_DIR } from '../../shared/src/state-dir.js';

export interface LaunchBaselineSnapshot {
  id: string;
  projectId: string;
  action: 'command' | 'review' | 'start';
  command: string | null;
  createdAt: number;
  readiness: ReturnType<typeof getProjectLaunchReadiness>;
  autonomy: ReturnType<typeof getProjectAutonomyHealth>;
  git: {
    branch: string | null;
    status: string[];
  };
  daemon: unknown | null;
}

function sanitizeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'baseline';
}

function tryGit(repoPath: string | null, args: string[]): string {
  if (!repoPath) return '';
  try {
    const result = spawnSync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return result.status === 0 ? (result.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

function readDaemonStatus(): unknown | null {
  const file = path.join(STATE_DIR, 'daemon-status.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function captureProjectLaunchBaseline(params: {
  projectId: string;
  action: 'command' | 'review' | 'start';
  command?: string | null;
}): { snapshot: LaunchBaselineSnapshot; filePath: string } {
  const readiness = getProjectLaunchReadiness(params.projectId);
  const autonomy = getProjectAutonomyHealth(params.projectId);
  const createdAt = Date.now();
  const id = `${createdAt}-${sanitizeFilePart(params.projectId)}-${sanitizeFilePart(params.command ?? params.action)}`;
  const baseDir = path.join(STATE_DIR, 'launch-baselines', params.projectId);
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const snapshot: LaunchBaselineSnapshot = {
    id,
    projectId: params.projectId,
    action: params.action,
    command: params.command ?? null,
    createdAt,
    readiness,
    autonomy,
    git: {
      branch: tryGit(readiness.repoPath, ['branch', '--show-current']) || null,
      status: (tryGit(readiness.repoPath, ['status', '--short']) || '').split(/\r?\n/).filter(Boolean),
    },
    daemon: readDaemonStatus(),
  };

  const filePath = path.join(baseDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + '\n');
  return { snapshot, filePath };
}
