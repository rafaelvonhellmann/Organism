import { NextRequest } from 'next/server';
import { ensureTables } from '@/lib/db';
import { getFeedbackSessions } from '@/lib/queries';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  await ensureTables();

  const sessions = await getFeedbackSessions();
  return Response.json({ sessions });
}
