import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function n(v: unknown): number { return Number(v) || 0; }

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const { id } = await params;
  const client = getClient();
  if (!client) return Response.json({ error: 'No DB' }, { status: 500 });

  // Fetch project-specific metrics from the tasks/audit DB
  const projectId = id;

  // Total reviews (distinct review runs)
  const reviews = await client.execute(
    `SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND status = 'completed'`,
    [projectId]
  );

  // Total spend
  const spend = await client.execute(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM tasks WHERE project_id = ?`,
    [projectId]
  );

  // Active agents (agents with completed tasks)
  const agents = await client.execute(
    `SELECT COUNT(DISTINCT agent) as cnt FROM tasks WHERE project_id = ? AND status = 'completed'`,
    [projectId]
  );

  // Findings (HIGH lane tasks)
  const findings = await client.execute(
    `SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND lane = 'HIGH'`,
    [projectId]
  );

  // Approval rate
  const approved = await client.execute(
    `SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND status = 'completed'`,
    [projectId]
  );
  const total = await client.execute(
    `SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ?`,
    [projectId]
  );
  const approvalRate = n(total.rows[0]?.cnt) > 0
    ? Math.round(n(approved.rows[0]?.cnt) / n(total.rows[0]?.cnt) * 100)
    : 0;

  // Avg cost per review
  const avgCost = await client.execute(
    `SELECT AVG(cost_usd) as avg FROM tasks WHERE project_id = ? AND cost_usd > 0`,
    [projectId]
  );

  // Tasks by status
  const byStatus = await client.execute(
    `SELECT status, COUNT(*) as cnt FROM tasks WHERE project_id = ? GROUP BY status`,
    [projectId]
  );

  // Tasks by agent with cost
  const byAgent = await client.execute(
    `SELECT agent, COUNT(*) as tasks, COALESCE(SUM(cost_usd), 0) as cost FROM tasks WHERE project_id = ? GROUP BY agent ORDER BY cost DESC`,
    [projectId]
  );

  // Recent tasks
  const recent = await client.execute(
    `SELECT id, agent, status, lane, description, cost_usd, created_at, completed_at FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 10`,
    [projectId]
  );

  return Response.json({
    project: projectId,
    metrics: {
      reviewCount: n(reviews.rows[0]?.cnt),
      totalSpend: n(spend.rows[0]?.total),
      activeAgents: n(agents.rows[0]?.cnt),
      findingCount: n(findings.rows[0]?.cnt),
      approvalRate,
      avgReviewCost: Math.round(n(avgCost.rows[0]?.avg) * 1000) / 1000,
    },
    byStatus: Object.fromEntries(byStatus.rows.map(r => [r.status, n(r.cnt)])),
    byAgent: byAgent.rows.map(r => ({ agent: String(r.agent), tasks: n(r.tasks), cost: n(r.cost) })),
    recentTasks: recent.rows,
  });
}
