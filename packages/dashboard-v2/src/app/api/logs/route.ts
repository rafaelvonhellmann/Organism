import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function n(v: unknown): number { return Number(v) || 0; }
function s(v: unknown): string { return v == null ? '' : String(v); }

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const client = getClient();
  if (!client) return Response.json({ logs: [] });

  const since = req.nextUrl.searchParams.get('since');
  const limit = req.nextUrl.searchParams.get('limit') ?? '50';

  let query = 'SELECT id, ts, agent, task_id, action, payload, outcome, error_code FROM audit_log';
  const args: (string | number)[] = [];

  if (since) {
    query += ' WHERE ts > ?';
    args.push(parseInt(since));
  }

  query += ' ORDER BY ts DESC LIMIT ?';
  args.push(parseInt(limit));

  const result = await client.execute({ sql: query, args });

  return Response.json({
    logs: result.rows.map(r => ({
      id: n(r.id),
      ts: n(r.ts),
      agent: s(r.agent),
      taskId: s(r.task_id),
      action: s(r.action),
      outcome: s(r.outcome),
      errorCode: r.error_code ? s(r.error_code) : null,
    })),
  });
}
