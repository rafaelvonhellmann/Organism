/**
 * Dashboard auth behavior tests.
 *
 * Run with:
 *   npx tsx --test packages/dashboard-v2/src/lib/auth.test.ts
 */

import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import type { NextRequest } from 'next/server';
import { getDashboardAuthStatus, isDashboardAuthRequired, isQueryTokenAuthAllowed, requireAuth } from './auth';

const ORIGINAL_ENV = {
  DASHBOARD_ALLOW_QUERY_TOKEN: process.env.DASHBOARD_ALLOW_QUERY_TOKEN,
  DASHBOARD_AUTH_TOKEN: process.env.DASHBOARD_AUTH_TOKEN,
  DASHBOARD_REQUIRE_AUTH: process.env.DASHBOARD_REQUIRE_AUTH,
  NODE_ENV: process.env.NODE_ENV,
  VERCEL: process.env.VERCEL,
};

afterEach(() => {
  restoreEnv();
});

function restoreEnv() {
  setOptionalEnv('DASHBOARD_ALLOW_QUERY_TOKEN', ORIGINAL_ENV.DASHBOARD_ALLOW_QUERY_TOKEN);
  setOptionalEnv('DASHBOARD_AUTH_TOKEN', ORIGINAL_ENV.DASHBOARD_AUTH_TOKEN);
  setOptionalEnv('DASHBOARD_REQUIRE_AUTH', ORIGINAL_ENV.DASHBOARD_REQUIRE_AUTH);
  setOptionalEnv('NODE_ENV', ORIGINAL_ENV.NODE_ENV);
  setOptionalEnv('VERCEL', ORIGINAL_ENV.VERCEL);
}

function setOptionalEnv(key: keyof NodeJS.ProcessEnv, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function useEnv(env: {
  DASHBOARD_ALLOW_QUERY_TOKEN?: string;
  DASHBOARD_AUTH_TOKEN?: string;
  DASHBOARD_REQUIRE_AUTH?: string;
  NODE_ENV?: string;
  VERCEL?: string;
}) {
  delete process.env.DASHBOARD_ALLOW_QUERY_TOKEN;
  delete process.env.DASHBOARD_AUTH_TOKEN;
  delete process.env.DASHBOARD_REQUIRE_AUTH;
  delete process.env.NODE_ENV;
  delete process.env.VERCEL;

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
}

function mockRequest(options: {
  authorization?: string;
  cookieToken?: string;
  queryToken?: string;
} = {}): NextRequest {
  const url = new URL('http://localhost:3391/api/tasks');
  if (options.queryToken !== undefined) {
    url.searchParams.set('token', options.queryToken);
  }

  const headers = new Headers();
  if (options.authorization !== undefined) {
    headers.set('authorization', options.authorization);
  }

  return {
    headers,
    cookies: {
      get(name: string) {
        if (name !== 'organism-auth' || options.cookieToken === undefined) {
          return undefined;
        }

        return { name, value: options.cookieToken };
      },
    },
    nextUrl: url,
  } as unknown as NextRequest;
}

test('production without DASHBOARD_AUTH_TOKEN denies requests', () => {
  useEnv({ NODE_ENV: 'production' });

  assert.equal(isDashboardAuthRequired(), true);
  assert.equal(requireAuth(mockRequest()), false);
  assert.deepEqual(getDashboardAuthStatus(mockRequest()), {
    authRequired: true,
    authenticated: false,
    configured: false,
  });
});

test('Vercel without DASHBOARD_AUTH_TOKEN denies requests even outside NODE_ENV production', () => {
  useEnv({ NODE_ENV: 'development', VERCEL: '1' });

  assert.equal(isDashboardAuthRequired(), true);
  assert.deepEqual(getDashboardAuthStatus(mockRequest()), {
    authRequired: true,
    authenticated: false,
    configured: false,
  });
});

test('development without DASHBOARD_AUTH_TOKEN allows requests', () => {
  useEnv({ NODE_ENV: 'development' });

  assert.equal(requireAuth(mockRequest()), true);
  assert.deepEqual(getDashboardAuthStatus(mockRequest()), {
    authRequired: false,
    authenticated: true,
    configured: false,
  });
});

test('Authorization bearer token authorizes requests', () => {
  useEnv({ DASHBOARD_AUTH_TOKEN: 'secret-token', NODE_ENV: 'production' });

  assert.equal(
    requireAuth(mockRequest({ authorization: 'Bearer secret-token' })),
    true,
  );
});

test('organism-auth cookie authorizes requests', () => {
  useEnv({ DASHBOARD_AUTH_TOKEN: 'secret-token', NODE_ENV: 'production' });

  assert.equal(requireAuth(mockRequest({ cookieToken: 'secret-token' })), true);
});

test('query token is denied in production even with opt-in set', () => {
  useEnv({
    DASHBOARD_ALLOW_QUERY_TOKEN: 'true',
    DASHBOARD_AUTH_TOKEN: 'secret-token',
    NODE_ENV: 'production',
  });

  assert.equal(isQueryTokenAuthAllowed(), false);
  assert.equal(requireAuth(mockRequest({ queryToken: 'secret-token' })), false);
});

test('query token works only when explicitly enabled outside production', () => {
  useEnv({ DASHBOARD_AUTH_TOKEN: 'secret-token', NODE_ENV: 'development' });

  assert.equal(isQueryTokenAuthAllowed(), false);
  assert.equal(requireAuth(mockRequest({ queryToken: 'secret-token' })), false);

  process.env.DASHBOARD_ALLOW_QUERY_TOKEN = 'true';

  assert.equal(isQueryTokenAuthAllowed(), true);
  assert.equal(requireAuth(mockRequest({ queryToken: 'secret-token' })), true);
});
