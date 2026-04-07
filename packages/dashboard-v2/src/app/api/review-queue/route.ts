import { NextRequest } from 'next/server';
import { getClient, ensureTables } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function n(v: unknown): number { return Number(v) || 0; }
function s(v: unknown): string { return v == null ? '' : String(v); }

function tryParse(json: unknown): unknown {
  if (!json || typeof json !== 'string') return json ?? null;
  try { return JSON.parse(json); } catch { return json; }
}

function formatTask(row: Record<string, unknown>) {
  return {
    id: s(row.id),
    agent: s(row.agent),
    status: s(row.status),
    lane: s(row.lane),
    description: s(row.description),
    input: tryParse(row.input),
    output: tryParse(row.output),
    tokensUsed: row.tokens_used != null ? n(row.tokens_used) : null,
    costUsd: row.cost_usd != null ? n(row.cost_usd) : null,
    startedAt: row.started_at != null ? n(row.started_at) : null,
    completedAt: row.completed_at != null ? n(row.completed_at) : null,
    error: row.error ? s(row.error) : null,
    parentTaskId: row.parent_task_id ? s(row.parent_task_id) : null,
    projectId: s(row.project_id),
    createdAt: n(row.created_at),
  };
}

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  const client = getClient();
  if (!client) {
    return Response.json({ tasks: [], total: 0, reviewed: 0, pending: 0 });
  }

  await ensureTables();

  const sp = req.nextUrl.searchParams;
  const project = sp.get('project');

  // Use parameterized queries for safety and performance
  const projectFilter = project
    ? ` AND t.project_id = ?`
    : '';
  const projectArgs = project ? [project] : [];

  // Exclude internal pipeline agents from the review queue.
  // A task is "reviewed" if it has a non-reply decision in review_decisions
  // OR a resolved G4 gate entry. Both core and dashboard now use gate='G4'.
  //
  // Performance: only SELECT columns needed for the card display,
  // skip the heavy 'input' column.

  const [tasksResult, reviewedResult] = await Promise.all([
    client.execute({
      sql: `SELECT t.id, t.agent, t.status, t.lane, t.description,
                   t.output, t.tokens_used, t.cost_usd, t.started_at,
                   t.completed_at, t.error, t.parent_task_id, t.project_id,
                   t.created_at
            FROM tasks t
            WHERE t.agent NOT IN ('grill-me', 'codex-review', 'quality-agent')
              AND t.status IN ('awaiting_review', 'completed')${projectFilter}
              AND NOT EXISTS (
                SELECT 1 FROM review_decisions rd
                WHERE rd.task_id = t.id
                  AND rd.decision IN ('approved', 'rejected', 'dismissed', 'changes_requested')
              )
              AND NOT EXISTS (
                SELECT 1 FROM gates g
                WHERE g.task_id = t.id AND g.gate = 'G4'
                  AND g.decision != 'pending'
              )
            ORDER BY
              CASE WHEN t.status = 'awaiting_review' THEN 0 ELSE 1 END,
              t.created_at DESC
            LIMIT 200`,
      args: projectArgs,
    }),
    client.execute({
      sql: `SELECT COUNT(DISTINCT t.id) as c
            FROM tasks t
            WHERE t.agent NOT IN ('grill-me', 'codex-review', 'quality-agent')
              AND t.status IN ('awaiting_review', 'completed')${projectFilter}
              AND (
                EXISTS (
                  SELECT 1 FROM review_decisions rd
                  WHERE rd.task_id = t.id
                    AND rd.decision IN ('approved', 'rejected', 'dismissed', 'changes_requested')
                )
                OR EXISTS (
                  SELECT 1 FROM gates g
                  WHERE g.task_id = t.id AND g.gate = 'G4'
                    AND g.decision != 'pending'
                )
              )`,
      args: projectArgs,
    }),
  ]);

  const tasks = tasksResult.rows.map(formatTask);
  const reviewed = n(reviewedResult.rows[0]?.c);

  return Response.json({
    tasks,
    total: tasks.length,
    reviewed,
    pending: tasks.length,
  });
}
