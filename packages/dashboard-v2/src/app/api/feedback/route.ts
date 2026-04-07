import { NextRequest } from 'next/server';
import { ensureTables } from '@/lib/db';
import { getExternalFeedback, getExternalFeedbackCounts } from '@/lib/queries';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  await ensureTables();

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status') ?? undefined;
  const sessionId = sp.get('session_id') ?? undefined;
  const source = sp.get('source') ?? undefined;
  const countsOnly = sp.get('counts') === '1';

  if (countsOnly) {
    const counts = await getExternalFeedbackCounts();
    return Response.json(counts);
  }

  const [items, counts] = await Promise.all([
    getExternalFeedback({ status, sessionId, source }),
    getExternalFeedbackCounts(),
  ]);

  return Response.json({ items, counts });
}
