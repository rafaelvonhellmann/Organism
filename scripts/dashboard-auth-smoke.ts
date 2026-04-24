/**
 * Read-only production auth smoke check for the dashboard.
 *
 * Usage:
 *   DASHBOARD_SMOKE_BASE_URL=https://organism-hq.vercel.app npm run smoke:dashboard-auth
 */

interface Probe {
  label: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  expectedStatus: number;
}

const baseUrl = (process.env.DASHBOARD_SMOKE_BASE_URL ?? 'https://organism-hq.vercel.app').replace(/\/+$/, '');

const protectedProbes: Probe[] = [
  { label: 'tasks list', path: '/api/tasks', expectedStatus: 401 },
  { label: 'actions list', path: '/api/actions', expectedStatus: 401 },
  { label: 'runtime snapshot', path: '/api/runtime?project=organism', expectedStatus: 401 },
  { label: 'health snapshot', path: '/api/health', expectedStatus: 401 },
  {
    label: 'command action POST',
    path: '/api/actions',
    method: 'POST',
    body: {},
    expectedStatus: 401,
  },
];

const requiredHeaders = [
  'content-security-policy',
  'referrer-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
];

async function checkAuthStatus(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/auth`, { cache: 'no-store' });
  if (response.status === 401) {
    return;
  }

  if (!response.ok) {
    throw new Error(`/api/auth returned ${response.status}`);
  }

  const body = await response.json() as {
    authRequired?: unknown;
    authenticated?: unknown;
    configured?: unknown;
  };

  if (body.authRequired !== true) {
    throw new Error(`/api/auth must report authRequired=true, got ${JSON.stringify(body)}`);
  }
  if (body.authenticated !== false) {
    throw new Error(`/api/auth must report authenticated=false for an unauthenticated probe, got ${JSON.stringify(body)}`);
  }
  if (body.configured !== true) {
    throw new Error(`/api/auth must report configured=true so login can work, got ${JSON.stringify(body)}`);
  }
}

async function checkProtectedProbe(probe: Probe): Promise<void> {
  const response = await fetch(`${baseUrl}${probe.path}`, {
    method: probe.method ?? 'GET',
    cache: 'no-store',
    headers: probe.body == null ? undefined : { 'Content-Type': 'application/json' },
    body: probe.body == null ? undefined : JSON.stringify(probe.body),
  });

  if (response.status !== probe.expectedStatus) {
    throw new Error(`${probe.label} returned ${response.status}; expected ${probe.expectedStatus}`);
  }
}

async function checkSecurityHeaders(): Promise<void> {
  const response = await fetch(`${baseUrl}/`, { cache: 'no-store' });
  const missing = requiredHeaders.filter((name) => !response.headers.get(name));
  if (missing.length > 0) {
    throw new Error(`Missing security header(s): ${missing.join(', ')}`);
  }
}

async function main(): Promise<void> {
  console.log(`Dashboard auth smoke: ${baseUrl}`);

  await checkAuthStatus();
  for (const probe of protectedProbes) {
    await checkProtectedProbe(probe);
  }
  await checkSecurityHeaders();

  console.log('Dashboard auth smoke passed.');
}

main().catch((error) => {
  console.error('Dashboard auth smoke failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
