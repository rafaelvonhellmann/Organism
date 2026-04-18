import { NextRequest } from 'next/server';
import { getClient, ensureTables } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function n(v: unknown): number { return Number(v) || 0; }
function s(v: unknown): string { return v == null ? '' : String(v); }
function esc(v: string): string { return v.replace(/'/g, "''"); }

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  const client = getClient();
  if (!client) {
    return Response.json({ tasks: [], total: 0 });
  }

  await ensureTables();

  const sp = req.nextUrl.searchParams;
  const project = sp.get('project');
  const decision = sp.get('decision');
  const agent = sp.get('agent');

  // Build WHERE filters using parameterized args
  const conditions: string[] = [
    "t.agent NOT IN ('domain-model', 'grill-me', 'codex-review', 'quality-agent')",
  ];
  const args: (string | number)[] = [];

  if (project) {
    conditions.push('t.project_id = ?');
    args.push(project);
  }
  if (agent) {
    conditions.push('t.agent = ?');
    args.push(agent);
  }

  // Try review_decisions first (dashboard-owned), fall back to gates
  try {
    const decisionFilter = decision
      ? ` AND rd.decision = '${esc(decision)}'`
      : '';

    const result = await client.execute({
      sql: `SELECT t.id, t.agent, t.description, t.lane, t.cost_usd, t.completed_at, t.created_at,
                   rd.decision, rd.reason, rd.decided_at
            FROM tasks t
            INNER JOIN review_decisions rd ON rd.task_id = t.id
            WHERE ${conditions.join(' AND ')}
              AND rd.decision IN ('approved', 'rejected', 'dismissed', 'changes_requested')${decisionFilter}
            ORDER BY rd.decided_at DESC
            LIMIT 200`,
      args,
    });

    if (result.rows.length > 0) {
      return Response.json({
        tasks: result.rows.map(row => ({
          id: s(row.id),
          agent: s(row.agent),
          description: s(row.description),
          lane: s(row.lane),
          costUsd: row.cost_usd != null ? n(row.cost_usd) : null,
          completedAt: row.completed_at != null ? n(row.completed_at) : null,
          createdAt: n(row.created_at),
          gate: {
            decision: s(row.decision),
            reason: row.reason ? s(row.reason) : null,
            decidedAt: row.decided_at != null ? n(row.decided_at) : null,
          },
        })),
        total: result.rows.length,
      });
    }
  } catch {
    // review_decisions table may not exist yet -- fall through to gates
  }

  // Fallback: use gates table
  const decisionFilter = decision
    ? ` AND g.decision = '${esc(decision)}'`
    : '';

  const result = await client.execute({
    sql: `SELECT t.id, t.agent, t.description, t.lane, t.cost_usd, t.completed_at, t.created_at,
                 g.decision, g.reason, g.decided_at
          FROM tasks t
          INNER JOIN gates g ON g.task_id = t.id
          WHERE g.gate = 'G4'
            AND g.decision != 'pending'
            AND ${conditions.join(' AND ')}${decisionFilter}
          ORDER BY g.decided_at DESC
          LIMIT 200`,
    args,
  });

  const tasks = result.rows.map(row => ({
    id: s(row.id),
    agent: s(row.agent),
    description: s(row.description),
    lane: s(row.lane),
    costUsd: row.cost_usd != null ? n(row.cost_usd) : null,
    completedAt: row.completed_at != null ? n(row.completed_at) : null,
    createdAt: n(row.created_at),
    gate: {
      decision: s(row.decision),
      reason: row.reason ? s(row.reason) : null,
      decidedAt: row.decided_at != null ? n(row.decided_at) : null,
    },
  }));

  return Response.json({ tasks, total: tasks.length });
}
