import { chromium, Browser, Page } from 'playwright';
import { mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const SCREENSHOTS_DIR = resolve(__dirname, '../../../state/screenshots');
const NAV_TIMEOUT = 30_000;

let _browser: Browser | null = null;

function ensureScreenshotsDir(): void {
  if (!existsSync(SCREENSHOTS_DIR)) {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

function slugify(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Launch or reuse a headless Chromium instance. */
export async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({ headless: true });
  return _browser;
}

/** Navigate to a URL and save a screenshot. */
export async function screenshotPage(
  url: string,
  options?: { fullPage?: boolean; width?: number; height?: number },
): Promise<{ path: string; title: string }> {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage({
      viewport: {
        width: options?.width ?? 1280,
        height: options?.height ?? 720,
      },
    });
    await page.goto(url, { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' });
    const title = await page.title();

    ensureScreenshotsDir();
    const filename = `${Date.now()}-${slugify(url)}.png`;
    const filepath = join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: options?.fullPage ?? false });
    await page.close();
    return { path: filepath, title };
  } catch (err: any) {
    return { path: '', title: `ERROR: ${err.message}` };
  }
}

/** Navigate to a URL and extract text content + links. */
export async function getPageContent(url: string): Promise<{
  title: string;
  text: string;
  url: string;
  links: Array<{ text: string; href: string }>;
}> {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.goto(url, { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' });

    const title = await page.title();
    const text = await page.innerText('body');
    const links = await page.$$eval('a[href]', (anchors) =>
      anchors.map((a) => ({
        text: (a as HTMLAnchorElement).innerText.trim(),
        href: (a as HTMLAnchorElement).href,
      })),
    );
    const finalUrl = page.url();
    await page.close();
    return { title, text, url: finalUrl, links };
  } catch (err: any) {
    return { title: `ERROR: ${err.message}`, text: '', url, links: [] };
  }
}

/** Check if a URL is accessible; returns status code. */
export async function checkUrl(url: string): Promise<{
  status: number;
  ok: boolean;
  redirectUrl?: string;
}> {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    const response = await page.goto(url, { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;
    const finalUrl = page.url();
    await page.close();
    return {
      status,
      ok: status >= 200 && status < 400,
      redirectUrl: finalUrl !== url ? finalUrl : undefined,
    };
  } catch (err: any) {
    return { status: 0, ok: false };
  }
}

/** Run a sequence of browser actions (navigate, click, fill, wait, screenshot). */
export async function testAuthFlow(
  url: string,
  steps: Array<{
    action: 'goto' | 'click' | 'fill' | 'wait' | 'screenshot';
    selector?: string;
    value?: string;
    url?: string;
  }>,
): Promise<{ success: boolean; screenshots: string[]; errors: string[] }> {
  const screenshots: string[] = [];
  const errors: string[] = [];
  let page: Page | null = null;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.goto(url, { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' });

    for (const step of steps) {
      try {
        switch (step.action) {
          case 'goto':
            await page.goto(step.url ?? url, { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' });
            break;
          case 'click':
            if (!step.selector) throw new Error('click requires a selector');
            await page.click(step.selector, { timeout: NAV_TIMEOUT });
            break;
          case 'fill':
            if (!step.selector) throw new Error('fill requires a selector');
            await page.fill(step.selector, step.value ?? '');
            break;
          case 'wait':
            if (step.selector) {
              await page.waitForSelector(step.selector, { timeout: NAV_TIMEOUT });
            } else {
              await page.waitForTimeout(parseInt(step.value ?? '1000', 10));
            }
            break;
          case 'screenshot': {
            ensureScreenshotsDir();
            const filename = `${Date.now()}-auth-step.png`;
            const filepath = join(SCREENSHOTS_DIR, filename);
            await page.screenshot({ path: filepath });
            screenshots.push(filepath);
            break;
          }
        }
      } catch (stepErr: any) {
        errors.push(`Step ${step.action}: ${stepErr.message}`);
      }
    }
  } catch (err: any) {
    errors.push(err.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }

  return { success: errors.length === 0, screenshots, errors };
}

/** Close the shared browser instance. */
export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
