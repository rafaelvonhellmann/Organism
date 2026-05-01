import { NextRequest } from 'next/server';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';
import { readAutoresearchLedger } from '@/lib/autoresearch-ledger';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : undefined;
  const data = readAutoresearchLedger({ limit });

  return Response.json(data, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
