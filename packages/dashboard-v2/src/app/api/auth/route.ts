import { NextRequest } from 'next/server';
import { getDashboardAuthStatus, getDashboardAuthToken, isDashboardAuthRequired } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth — validate token and set cookie.
 * GET  /api/auth — check if auth is required and if current cookie is valid.
 */

export async function POST(req: NextRequest) {
  const expected = getDashboardAuthToken();
  if (!expected) {
    if (isDashboardAuthRequired()) {
      return Response.json(
        {
          ok: false,
          authRequired: true,
          error: 'Dashboard auth is required but DASHBOARD_AUTH_TOKEN is not configured',
        },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return Response.json(
      { ok: true, authRequired: false },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const body = await req.json();
  const token = body.token as string | undefined;

  if (!token || token !== expected) {
    return Response.json(
      { ok: false, error: 'Invalid token' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Set cookie (httpOnly, secure in production, 30 day expiry)
  const isSecure = req.nextUrl.protocol === 'https:';
  const cookie = [
    `organism-auth=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${30 * 24 * 60 * 60}`,
    ...(isSecure ? ['Secure'] : []),
  ].join('; ');

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    },
  });
}

export async function GET(req: NextRequest) {
  const { authRequired, authenticated, configured } = getDashboardAuthStatus(req);
  return Response.json(
    { authRequired, authenticated, configured },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
