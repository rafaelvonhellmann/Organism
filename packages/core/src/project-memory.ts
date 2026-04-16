import * as fs from 'fs';
import * as path from 'path';
import { getDb } from './task-queue.js';
import { STATE_DIR } from '../../shared/src/state-dir.js';

export interface ProjectMemorySnapshot {
  id: string;
  projectId: string;
  createdAt: number;
  recentGoals: Array<{
    id: string;
    title: string;
    workflowKind: string;
    status: string;
    updatedAt: number;
  }>;
  blockers: Array<{
    taskId: string;
    agent: string;
    status: string;
    workflowKind: string | null;
    description: string;
    error: string | null;
  }>;
  recentOutputs: Array<{
    taskId: string;
    agent: string;
    workflowKind: string | null;
    description: string;
    summary: string | null;
    completedAt: number | null;
  }>;
  workingSummary: string[];
}

function sanitizeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'memory';
}

function summarizeOutput(raw: string | null): string | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidateKeys = ['summary', 'review', 'report', 'result', 'text', 'implementation', 'analysis'];
    for (const key of candidateKeys) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim().replace(/\s+/g, ' ').slice(0, 240);
      }
    }

    const firstString = Object.values(parsed).find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return firstString ? firstString.trim().replace(/\s+/g, ' ').slice(0, 240) : null;
  } catch {
    return raw.trim().replace(/\s+/g, ' ').slice(0, 240);
  }
}

function buildWorkingSummary(snapshot: Omit<ProjectMemorySnapshot, 'workingSummary'>): string[] {
  const summary: string[] = [];

  const latestGoal = snapshot.recentGoals[0];
  if (latestGoal) {
    summary.push(`Latest goal: ${latestGoal.title} (${latestGoal.workflowKind}, ${latestGoal.status}).`);
  }

  if (snapshot.blockers.length > 0) {
    const blocker = snapshot.blockers[0];
    summary.push(`Current blocker: ${blocker.agent} is ${blocker.status} on "${blocker.description.slice(0, 120)}".`);
  }

  if (snapshot.recentOutputs.length > 0) {
    const output = snapshot.recentOutputs[0];
    const detail = output.summary ?? output.description;
    summary.push(`Latest useful output: ${output.agent} completed ${output.workflowKind ?? 'work'} on "${detail.slice(0, 140)}".`);
  }

  return summary;
}

export function captureProjectMemorySnapshot(projectId: string): { snapshot: ProjectMemorySnapshot; filePath: string } {
  const db = getDb();
  const createdAt = Date.now();
  const id = `${createdAt}-${sanitizeFilePart(projectId)}-memory`;

  const recentGoals = db.prepare(`
    SELECT id, title, workflow_kind, status, updated_at
    FROM goals
    WHERE project_id = ?
    ORDER BY updated_at DESC
    LIMIT 5
  `).all(projectId) as Array<{
    id: string;
    title: string;
    workflow_kind: string;
    status: string;
    updated_at: number;
  }>;

  const blockers = db.prepare(`
    SELECT id, agent, status, workflow_kind, description, error
    FROM tasks
    WHERE project_id = ?
      AND status IN ('paused', 'retry_scheduled', 'awaiting_review')
    ORDER BY COALESCE(completed_at, started_at, created_at) DESC
    LIMIT 5
  `).all(projectId) as Array<{
    id: string;
    agent: string;
    status: string;
    workflow_kind: string | null;
    description: string;
    error: string | null;
  }>;

  const recentOutputs = db.prepare(`
    SELECT id, agent, workflow_kind, description, output, completed_at
    FROM tasks
    WHERE project_id = ?
      AND status = 'completed'
    ORDER BY COALESCE(completed_at, created_at) DESC
    LIMIT 5
  `).all(projectId) as Array<{
    id: string;
    agent: string;
    workflow_kind: string | null;
    description: string;
    output: string | null;
    completed_at: number | null;
  }>;

  const baseSnapshot = {
    id,
    projectId,
    createdAt,
    recentGoals: recentGoals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      workflowKind: goal.workflow_kind,
      status: goal.status,
      updatedAt: goal.updated_at,
    })),
    blockers: blockers.map((blocker) => ({
      taskId: blocker.id,
      agent: blocker.agent,
      status: blocker.status,
      workflowKind: blocker.workflow_kind,
      description: blocker.description,
      error: blocker.error,
    })),
    recentOutputs: recentOutputs.map((output) => ({
      taskId: output.id,
      agent: output.agent,
      workflowKind: output.workflow_kind,
      description: output.description,
      summary: summarizeOutput(output.output),
      completedAt: output.completed_at,
    })),
  };

  const snapshot: ProjectMemorySnapshot = {
    ...baseSnapshot,
    workingSummary: buildWorkingSummary(baseSnapshot),
  };

  const baseDir = path.join(STATE_DIR, 'project-memory', projectId);
  fs.mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + '\n');

  return { snapshot, filePath };
}
