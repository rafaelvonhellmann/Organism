import { NextRequest } from 'next/server';
import { getBudgetSummary } from '@/lib/queries';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  return Response.json(await getBudgetSummary());
}
