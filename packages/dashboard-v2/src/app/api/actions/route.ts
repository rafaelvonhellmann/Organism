import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 50;
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(100, Math.max(1, parsed));
}

// GET: list recent actions and their status
export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const client = getClient();
  if (!client) return Response.json({ actions: [] });
  const project = req.nextUrl.searchParams.get('project')?.trim();
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'));

  const result = await client.execute(
    {
      sql: 'SELECT * FROM dashboard_actions ORDER BY created_at DESC LIMIT ?',
      args: [limit],
    },
  );
  const actions = project
    ? result.rows.filter((row) => {
        try {
          const payload = row.payload ? JSON.parse(String(row.payload)) as { project?: string } : {};
          return payload.project === project;
        } catch {
          return false;
        }
      })
    : result.rows;
  return Response.json({ actions, limit }, { headers: { 'Cache-Control': 'no-store' } });
}

// POST: create a new action request
export async function POST(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const client = getClient();
  if (!client) return Response.json({ error: 'No database connection' }, { status: 500 });

  const body = await req.json();
  const { action, payload } = body;

  if (!action) return Response.json({ error: 'Missing action' }, { status: 400 });
  const projectRequired = action === 'command' || action === 'review' || action === 'start';
  if (projectRequired && (!payload || typeof payload.project !== 'string' || payload.project.trim().length === 0)) {
    return Response.json({ error: 'Project selection is required for this action' }, { status: 400 });
  }

  try {
    await client.execute({
      sql: 'INSERT INTO dashboard_actions (action, payload, status, created_at) VALUES (?, ?, ?, ?)',
      args: [action, JSON.stringify(payload ?? {}), 'pending', Date.now()],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }

  return Response.json({ ok: true, action });
}
