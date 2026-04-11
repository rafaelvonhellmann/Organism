import { NextRequest } from 'next/server';
import { getClient, ensureTables } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  const client = getClient();
  if (!client) return Response.json({ cycles: [] });

  await ensureTables();

  const project = req.nextUrl.searchParams.get('project');

  try {
    const result = project
      ? await client.execute({
          sql: `SELECT * FROM review_cycles WHERE project_id = ? ORDER BY started_at DESC LIMIT 20`,
          args: [project],
        })
      : await client.execute(`SELECT * FROM review_cycles ORDER BY started_at DESC LIMIT 20`);

    return Response.json({ cycles: result.rows });
  } catch {
    // Table may not exist yet
    return Response.json({ cycles: [] });
  }
}
