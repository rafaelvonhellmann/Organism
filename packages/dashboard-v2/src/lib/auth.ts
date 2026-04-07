import { NextRequest } from 'next/server';

/**
 * Simple token-based auth for the dashboard API.
 *
 * Checks (in order):
 *   1. Authorization: Bearer <token> header
 *   2. ?token=<token> query parameter
 *   3. organism-auth cookie
 *
 * If DASHBOARD_AUTH_TOKEN is not set, auth is DISABLED (development mode).
 * Returns true if authorized, false otherwise.
 */
export function requireAuth(request: NextRequest): boolean {
  const expected = process.env.DASHBOARD_AUTH_TOKEN?.trim();
  if (!expected) {
    // Development mode — no token configured, auth disabled
    if (!_devWarned) {
      console.warn('[auth] DASHBOARD_AUTH_TOKEN is not set — auth is DISABLED (development mode)');
      _devWarned = true;
    }
    return true;
  }

  // 1. Authorization header
  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1] === expected) return true;
  }

  // 2. Query parameter
  const tokenParam = request.nextUrl.searchParams.get('token');
  if (tokenParam && tokenParam === expected) return true;

  // 3. Cookie
  const cookie = request.cookies.get('organism-auth');
  if (cookie && cookie.value === expected) return true;

  return false;
}

let _devWarned = false;

/** Standard 401 response */
export function unauthorizedResponse(): Response {
  return Response.json(
    { error: 'Unauthorized — provide a valid token via Authorization header, ?token= query param, or organism-auth cookie' },
    { status: 401 },
  );
}
