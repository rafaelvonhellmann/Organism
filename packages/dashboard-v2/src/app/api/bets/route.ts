import { NextRequest } from 'next/server';
import { getBets, getPausedBets } from '@/lib/queries';
import { ensureTables } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  await ensureTables();

  const sp = req.nextUrl.searchParams;

  // Special filter: ?paused=1 returns only paused bets with exception details
  if (sp.get('paused') === '1') {
    const data = await getPausedBets();
    return Response.json(data);
  }

  const data = await getBets({
    project: sp.get('project') ?? undefined,
    status: sp.get('status') ?? undefined,
  });
  return Response.json(data);
}
