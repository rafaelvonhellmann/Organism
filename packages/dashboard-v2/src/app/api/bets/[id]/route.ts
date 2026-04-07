import { NextRequest } from 'next/server';
import { getBetDetail, approveBetFromDashboard, rejectBetFromDashboard } from '@/lib/queries';
import { ensureTables } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!requireAuth(req)) return unauthorizedResponse();
  await ensureTables();

  const { id } = await params;
  const data = await getBetDetail(id);
  if (!data) {
    return Response.json({ error: 'Bet not found' }, { status: 404 });
  }
  return Response.json(data);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!requireAuth(req)) return unauthorizedResponse();
  await ensureTables();

  const { id } = await params;

  let body: { action: string; notes?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.action || !['approve', 'reject'].includes(body.action)) {
    return Response.json({ error: 'action must be "approve" or "reject"' }, { status: 400 });
  }

  try {
    if (body.action === 'approve') {
      const result = await approveBetFromDashboard(id, 'rafael', body.notes);
      if (!result) return Response.json({ error: 'Bet not found or not in pitch_ready status' }, { status: 404 });
      return Response.json({ ok: true, bet: result });
    } else {
      const result = await rejectBetFromDashboard(id, 'rafael', body.notes);
      if (!result) return Response.json({ error: 'Bet not found or not in pitch_ready status' }, { status: 404 });
      return Response.json({ ok: true, bet: result });
    }
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
