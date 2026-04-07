import { NextRequest } from 'next/server';
import { getPitches } from '@/lib/queries';
import { ensureTables } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  await ensureTables();

  const sp = req.nextUrl.searchParams;
  const data = await getPitches({
    project: sp.get('project') ?? undefined,
    status: sp.get('status') ?? undefined,
  });
  return Response.json(data);
}
