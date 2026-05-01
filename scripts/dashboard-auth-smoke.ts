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

function cookieDomain(): string {
  return new URL(baseUrl).hostname;
}

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

async function checkBrowserProjectFlow(): Promise<void> {
  if (!dashboardAuthToken) {
    console.log('Skipping browser project smoke: DASHBOARD_AUTH_TOKEN is not set.');
    return;
  }
  if (process.env.DASHBOARD_SMOKE_BROWSER === '0') {
    console.log('Skipping browser project smoke: DASHBOARD_SMOKE_BROWSER=0.');
    return;
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{
      name: 'organism-auth',
      value: dashboardAuthToken,
      domain: cookieDomain(),
      path: '/',
      httpOnly: true,
      secure: baseUrl.startsWith('https://'),
      sameSite: 'Strict',
    }]);

    const page = await context.newPage();
    const browserFailures: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        browserFailures.push(`console:${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => browserFailures.push(`pageerror: ${error.message}`));
    page.on('response', (response) => {
      const status = response.status();
      const url = response.url();
      if (status >= 400 && url.startsWith(baseUrl)) {
        browserFailures.push(`http:${status}: ${url}`);
      }
    });

    await page.goto(`${baseUrl}/runtime`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('select', { timeout: 30_000 });

    const options = await page.locator('select option').evaluateAll((items) => (
      items.map((option) => option.getAttribute('value') ?? '')
    ));
    if (!options.includes('synapse')) {
      throw new Error(`Runtime project selector must include synapse, got ${JSON.stringify(options)}`);
    }

    await page.locator('select').selectOption('synapse');
    await page.waitForResponse(
      (response) => response.url().includes('/api/runtime?project=synapse'),
      { timeout: 30_000 },
    ).catch(() => null);

    const runtimeSelection = await page.locator('select').inputValue();
    if (runtimeSelection !== 'synapse') {
      throw new Error(`Runtime selector did not stay on synapse; got ${runtimeSelection}`);
    }

    await page.goto(`${baseUrl}/project/synapse`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('select', { timeout: 30_000 });
    const projectSelection = await page.locator('select').inputValue();
    if (projectSelection !== 'synapse') {
      throw new Error(`Project page selector did not initialize to synapse; got ${projectSelection}`);
    }

    await page.locator('select').selectOption('tokens-for-good');
    await page.waitForURL('**/project/tokens-for-good', { timeout: 30_000 });

    const bodyText = await page.locator('body').innerText({ timeout: 5_000 });
    if (/internal server error/i.test(bodyText)) {
      throw new Error('Browser project flow showed an internal server error');
    }

    if (browserFailures.length > 0) {
      throw new Error(`Browser project flow reported failures: ${browserFailures.join(' | ')}`);
    }
  } finally {
    await browser.close();
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
  await checkBrowserProjectFlow();

  console.log('Dashboard auth smoke passed.');
}

main().catch((error) => {
  console.error('Dashboard auth smoke failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
