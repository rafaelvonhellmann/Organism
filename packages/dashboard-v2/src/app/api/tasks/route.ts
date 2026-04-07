import { NextRequest } from 'next/server';
import { getTasks } from '@/lib/queries';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const sp = req.nextUrl.searchParams;
  const data = await getTasks({
    status: sp.get('status') ?? undefined,
    agent: sp.get('agent') ?? undefined,
    project: sp.get('project') ?? undefined,
    lane: sp.get('lane') ?? undefined,
    limit: sp.has('limit') ? parseInt(sp.get('limit')!, 10) : undefined,
    offset: sp.has('offset') ? parseInt(sp.get('offset')!, 10) : undefined,
  });
  return Response.json(data);
}
