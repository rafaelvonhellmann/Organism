import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth — validate token and set cookie.
 * GET  /api/auth — check if auth is required and if current cookie is valid.
 */

export async function POST(req: NextRequest) {
  const expected = process.env.DASHBOARD_AUTH_TOKEN?.trim();
  if (!expected) {
    // No auth configured — always OK
    return Response.json({ ok: true, authRequired: false });
  }

  const body = await req.json();
  const token = body.token as string | undefined;

  if (!token || token !== expected) {
    return Response.json({ ok: false, error: 'Invalid token' }, { status: 401 });
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
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    },
  });
}

export async function GET(req: NextRequest) {
  const expected = process.env.DASHBOARD_AUTH_TOKEN?.trim();
  if (!expected) {
    return Response.json({ authRequired: false, authenticated: true });
  }

  const cookie = req.cookies.get('organism-auth');
  const authenticated = cookie?.value === expected;

  return Response.json({ authRequired: true, authenticated });
}
