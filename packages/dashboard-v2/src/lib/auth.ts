import { NextRequest } from 'next/server';

export interface DashboardAuthStatus {
  authRequired: boolean;
  authenticated: boolean;
  configured: boolean;
}

/**
 * Simple token-based auth for the dashboard API.
 *
 * Checks (in order):
 *   1. Authorization: Bearer <token> header
 *   2. organism-auth cookie
 *   3. ?token=<token> query parameter, only when explicitly enabled outside production
 *
 * If DASHBOARD_AUTH_TOKEN is not set, auth is disabled only in development mode.
 * Returns true if authorized, false otherwise.
 */
export function requireAuth(request: NextRequest): boolean {
  const expected = getDashboardAuthToken();
  if (!expected) {
    if (isDashboardAuthRequired()) return false;
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

  // 2. Cookie
  const cookie = request.cookies.get('organism-auth');
  if (cookie && cookie.value === expected) return true;

  // 3. Query parameter, local/dev opt-in only.
  if (isQueryTokenAuthAllowed()) {
    const tokenParam = request.nextUrl.searchParams.get('token');
    if (tokenParam && tokenParam === expected) return true;
  }

  return false;
}

let _devWarned = false;

export function isDashboardAuthRequired(): boolean {
  return process.env.NODE_ENV === 'production'
    || process.env.VERCEL === '1'
    || /^(1|true|yes)$/i.test(process.env.DASHBOARD_REQUIRE_AUTH ?? '');
}

export function getDashboardAuthToken(): string | null {
  return process.env.DASHBOARD_AUTH_TOKEN?.trim() || null;
}

export function getDashboardAuthStatus(request: NextRequest): DashboardAuthStatus {
  const configured = Boolean(getDashboardAuthToken());
  const authRequired = configured || isDashboardAuthRequired();

  return {
    authRequired,
    authenticated: authRequired ? requireAuth(request) : true,
    configured,
  };
}

export function isQueryTokenAuthAllowed(): boolean {
  return process.env.NODE_ENV !== 'production'
    && process.env.VERCEL !== '1'
    && /^(1|true|yes)$/i.test(process.env.DASHBOARD_ALLOW_QUERY_TOKEN ?? '');
}

/** Standard 401 response */
export function unauthorizedResponse(): Response {
  return Response.json(
    { error: 'Unauthorized — provide a valid token via Authorization header or organism-auth cookie' },
    {
      status: 401,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
