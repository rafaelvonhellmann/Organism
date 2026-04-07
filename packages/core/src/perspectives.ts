import * as fs from 'fs';
import * as path from 'path';
import { Perspective } from '../../shared/src/types.js';
import { getDb } from './task-queue.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const REGISTRY_PATH = path.join(ROOT, 'knowledge/perspective-registry.json');

let _cache: Perspective[] | null = null;

export function loadPerspectives(): Perspective[] {
  if (_cache) return _cache;
  const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as { perspectives: Perspective[] };
  _cache = raw.perspectives;
  return _cache;
}

export function savePerspectives(perspectives: Perspective[]): void {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ perspectives }, null, 2), 'utf8');
  _cache = perspectives;
}

export function getPerspective(id: string): Perspective | undefined {
  return loadPerspectives().find(p => p.id === id);
}

export function getActivePerspectives(): Perspective[] {
  return loadPerspectives().filter(p => p.status === 'active');
}

/**
 * Select perspectives for a given project and scope.
 * Uses fitness scores when available, falls back to keyword matching.
 */
export function selectPerspectives(
  projectId: string,
  scope?: string,
  maxPerspectives = 15,
): Perspective[] {
  const all = getActivePerspectives();

  // Score each perspective for this project
  const scored = all.map(p => {
    let score = 0;

    // Try SQLite fitness first (more accurate), fall back to JSON registry
    const sqliteFitness = getFitness(p.id, projectId);
    if (sqliteFitness && sqliteFitness.invocations >= 5) {
      // Use computed fitness score from real data
      score = sqliteFitness.fitnessScore;
    } else if (p.projectFitness[projectId] !== undefined) {
      score = p.projectFitness[projectId];
    } else {
      // Newcomer bonus
      score = 0.5;
    }

    // Keyword boost if scope matches
    if (scope) {
      const scopeLower = scope.toLowerCase();
      const keywordMatch = p.relevanceKeywords.some(k => scopeLower.includes(k));
      if (keywordMatch) score += 0.3;
    }

    return { perspective: p, score };
  });

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxPerspectives).map(s => s.perspective);
}

/**
 * Record that a perspective was invoked and update its stats.
 */
export function recordPerspectiveInvocation(
  perspectiveId: string,
  projectId: string,
  costUsd: number,
): void {
  const perspectives = loadPerspectives();
  const p = perspectives.find(x => x.id === perspectiveId);
  if (!p) return;

  p.totalInvocations++;
  p.totalCostUsd += costUsd;
  p.lastUsed = Date.now();

  // Initialize project fitness if not set
  if (p.projectFitness[projectId] === undefined) {
    p.projectFitness[projectId] = 0.5; // newcomer default
  }

  savePerspectives(perspectives);

  // Also update SQLite fitness table for Darwinian tracking
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO perspective_fitness (perspective_id, project_id, invocations, total_cost_usd, last_invoked)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(perspective_id, project_id) DO UPDATE SET
        invocations = invocations + 1,
        total_cost_usd = total_cost_usd + ?,
        last_invoked = ?
    `).run(perspectiveId, projectId, costUsd, Date.now(), costUsd, Date.now());
  } catch { /* fitness table might not exist yet — safe to skip */ }
}

/**
 * Get fitness data for a perspective-project pair from SQLite.
 */
export function getFitness(perspectiveId: string, projectId: string): {
  invocations: number;
  totalCostUsd: number;
  avgQualityScore: number;
  avgRating: number;
  usefulCount: number;
  dismissedCount: number;
  lastInvoked: number;
  fitnessScore: number;
} | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM perspective_fitness WHERE perspective_id = ? AND project_id = ?'
  ).get(perspectiveId, projectId) as Record<string, number> | undefined;

  if (!row) return null;

  const fitnessScore = computeFitnessScore(row);

  return {
    invocations: row.invocations ?? 0,
    totalCostUsd: row.total_cost_usd ?? 0,
    avgQualityScore: row.avg_quality_score ?? 0,
    avgRating: row.avg_rating ?? 0,
    usefulCount: row.useful_count ?? 0,
    dismissedCount: row.dismissed_count ?? 0,
    lastInvoked: row.last_invoked ?? 0,
    fitnessScore,
  };
}

/**
 * Compute the Darwinian fitness score (0-1).
 */
function computeFitnessScore(row: Record<string, number>): number {
  const qualityWeight = 0.3;
  const ratingWeight = 0.3;
  const usefulWeight = 0.3;
  const recencyWeight = 0.1;

  const qualityScore = Math.min((row.avg_quality_score ?? 0) / 10, 1);
  const ratingScore = Math.min((row.avg_rating ?? 0) / 5, 1);

  const useful = row.useful_count ?? 0;
  const dismissed = row.dismissed_count ?? 0;
  const usefulScore = (useful + dismissed) > 0 ? useful / (useful + dismissed) : 0.5;

  // Recency: bonus if used in last 7 days
  const daysSinceUse = (Date.now() - (row.last_invoked ?? 0)) / (1000 * 60 * 60 * 24);
  const recencyScore = daysSinceUse < 7 ? 1 : daysSinceUse < 30 ? 0.5 : 0;

  return (qualityScore * qualityWeight) +
    (ratingScore * ratingWeight) +
    (usefulScore * usefulWeight) +
    (recencyScore * recencyWeight);
}

/**
 * Get all fitness data for a project (all perspectives).
 */
export function getProjectFitness(projectId: string): Array<{
  perspectiveId: string;
  fitnessScore: number;
  invocations: number;
  avgRating: number;
  totalCostUsd: number;
}> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM perspective_fitness WHERE project_id = ? ORDER BY avg_rating DESC'
  ).all(projectId) as Array<Record<string, number | string>>;

  return rows.map(row => ({
    perspectiveId: row.perspective_id as string,
    fitnessScore: computeFitnessScore(row as Record<string, number>),
    invocations: (row.invocations as number) ?? 0,
    avgRating: (row.avg_rating as number) ?? 0,
    totalCostUsd: (row.total_cost_usd as number) ?? 0,
  }));
}

/**
 * Record a rating (1-5) from Rafael for a perspective's output.
 */
export function ratePerspective(perspectiveId: string, projectId: string, rating: number): void {
  const db = getDb();
  // Upsert: update running average
  db.prepare(`
    INSERT INTO perspective_fitness (perspective_id, project_id, avg_rating, invocations, last_invoked)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(perspective_id, project_id) DO UPDATE SET
      avg_rating = (avg_rating * invocations + ?) / (invocations + 1),
      useful_count = useful_count + CASE WHEN ? >= 3 THEN 1 ELSE 0 END,
      dismissed_count = dismissed_count + CASE WHEN ? < 3 THEN 1 ELSE 0 END,
      last_invoked = ?
  `).run(perspectiveId, projectId, rating, Date.now(), rating, rating, rating, Date.now());
}
