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
const dashboardAuthToken = process.env.DASHBOARD_AUTH_TOKEN?.trim();

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

const authenticatedProbes = [
  '/api/projects',
  '/api/project/synapse',
  '/api/runtime?project=synapse',
  '/api/review-queue?project=synapse',
  '/api/action-items?counts=1&project=synapse',
  '/project/synapse',
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

async function checkAuthenticatedProjectFlow(): Promise<void> {
  if (!dashboardAuthToken) {
    console.log('Skipping authenticated project smoke: DASHBOARD_AUTH_TOKEN is not set.');
    return;
  }

  const headers = {
    Cookie: `organism-auth=${dashboardAuthToken}`,
  };

  const authResponse = await fetch(`${baseUrl}/api/auth`, { cache: 'no-store', headers });
  if (!authResponse.ok) {
    throw new Error(`authenticated /api/auth returned ${authResponse.status}`);
  }

  const authBody = await authResponse.json() as {
    authRequired?: unknown;
    authenticated?: unknown;
    configured?: unknown;
  };
  if (authBody.authRequired !== true || authBody.authenticated !== true || authBody.configured !== true) {
    throw new Error(`authenticated /api/auth returned unexpected body ${JSON.stringify(authBody)}`);
  }

  for (const path of authenticatedProbes) {
    const response = await fetch(`${baseUrl}${path}`, { cache: 'no-store', headers });
    if (!response.ok) {
      throw new Error(`authenticated ${path} returned ${response.status}`);
    }

    if (path === '/api/projects') {
      const projects = await response.json() as unknown;
      if (!Array.isArray(projects) || !projects.includes('synapse')) {
        throw new Error(`/api/projects must include synapse, got ${JSON.stringify(projects)}`);
      }
      continue;
    }

    if (path === '/api/project/synapse') {
      const project = await response.json() as { project?: unknown; metrics?: unknown };
      if (project.project !== 'synapse' || !project.metrics) {
        throw new Error(`/api/project/synapse returned unexpected body ${JSON.stringify(project)}`);
      }
      continue;
    }

    if (path === '/project/synapse') {
      const text = await response.text();
      if (/internal server error/i.test(text)) {
        throw new Error('/project/synapse returned an internal server error page');
      }
    }
  }
}

async function main(): Promise<void> {
  console.log(`Dashboard auth smoke: ${baseUrl}`);

  await checkAuthStatus();
  for (const probe of protectedProbes) {
    await checkProtectedProbe(probe);
  }
  await checkSecurityHeaders();
  await checkAuthenticatedProjectFlow();

  console.log('Dashboard auth smoke passed.');
}

main().catch((error) => {
  console.error('Dashboard auth smoke failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
