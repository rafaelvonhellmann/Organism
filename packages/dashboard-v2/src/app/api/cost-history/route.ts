import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const client = getClient();
  if (!client) return Response.json({ costByDay: [], tasksByDay: [] });

  const daysParam = req.nextUrl.searchParams.get('days') ?? '30';
  const days = Math.max(1, Math.min(parseInt(daysParam) || 30, 365));

  // Daily cost from agent_spend
  const result = await client.execute({
    sql: `SELECT date, SUM(cost_usd) as total_cost, COUNT(DISTINCT agent) as agent_count
     FROM agent_spend
     WHERE date >= date('now', '-' || ? || ' days')
     GROUP BY date ORDER BY date ASC`,
    args: [days],
  });

  // Daily task counts
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const taskResult = await client.execute({
    sql: `SELECT date(created_at/1000, 'unixepoch') as date, COUNT(*) as count,
     SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
     FROM tasks
     WHERE created_at > ?
     GROUP BY date(created_at/1000, 'unixepoch') ORDER BY 1 ASC`,
    args: [cutoffMs],
  });

  return Response.json({
    costByDay: result.rows.map(r => ({
      date: String(r.date),
      cost: Number(r.total_cost) || 0,
      agents: Number(r.agent_count) || 0,
    })),
    tasksByDay: taskResult.rows.map(r => ({
      date: String(r.date),
      total: Number(r.count) || 0,
      completed: Number(r.completed) || 0,
    })),
  });
}
