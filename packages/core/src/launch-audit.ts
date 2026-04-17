import * as fs from 'fs';
import * as path from 'path';
import { loadProjectPolicy } from './project-policy.js';

export type LaunchCheckStatus = 'pass' | 'warn' | 'fail' | 'na';

export interface LaunchCheckItem {
  id: string;
  label: string;
  status: LaunchCheckStatus;
  summary: string;
  evidence: string[];
}

export interface LaunchAuditReport {
  projectId: string;
  repoPath: string | null;
  generatedAt: number;
  summary: {
    pass: number;
    warn: number;
    fail: number;
    na: number;
  };
  blockers: string[];
  items: LaunchCheckItem[];
}

interface RepoScan {
  repoPath: string | null;
  files: string[];
  textFiles: Array<{ relativePath: string; text: string }>;
}

const CACHE_TTL_MS = 60_000;
const MAX_SCAN_FILES = 1800;
const MAX_FILE_BYTES = 256 * 1024;
const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.sql', '.prisma', '.env', '.yaml', '.yml',
]);
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.vercel', 'out', 'tmp', '.tmp',
  '.claude', '.agents', '.ai', '.github', 'docs', 'tasks', 'data', 'tests', '__tests__', 'e2e', 'playwright-report',
]);

const auditCache = new Map<string, { expiresAt: number; report: LaunchAuditReport }>();

export function clearLaunchAuditCache(): void {
  auditCache.clear();
}

function trim(text: string, max = 220): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 15)}...[truncated]`;
}

function statusPriority(status: LaunchCheckStatus): number {
  switch (status) {
    case 'fail':
      return 3;
    case 'warn':
      return 2;
    case 'pass':
      return 1;
    default:
      return 0;
  }
}

function createItem(
  id: string,
  label: string,
  status: LaunchCheckStatus,
  summary: string,
  evidence: string[] = [],
): LaunchCheckItem {
  return { id, label, status, summary, evidence: evidence.slice(0, 5) };
}

function walkFiles(root: string): string[] {
  const output: string[] = [];
  const queue = [root];

  while (queue.length > 0 && output.length < MAX_SCAN_FILES) {
    const current = queue.shift()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (output.length >= MAX_SCAN_FILES) break;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const basename = entry.name.toLowerCase();
      if (/\.(test|spec)\.[^.]+$/i.test(basename) || /\.stories\.[^.]+$/i.test(basename)) continue;
      if (!SCAN_EXTENSIONS.has(ext) && !basename.startsWith('.env')) continue;
      output.push(fullPath);
    }
  }

  return output;
}

function scanRepo(repoPath: string | null): RepoScan {
  if (!repoPath || !fs.existsSync(repoPath)) {
    return { repoPath, files: [], textFiles: [] };
  }

  const files = walkFiles(repoPath);
  const textFiles = files.flatMap((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_BYTES) return [];
      const text = fs.readFileSync(filePath, 'utf8');
      return [{
        relativePath: path.relative(repoPath, filePath).replace(/\\/g, '/'),
        text,
      }];
    } catch {
      return [];
    }
  });

  return { repoPath, files, textFiles };
}

function findMatches(scan: RepoScan, pattern: RegExp, limit = 5): string[] {
  const matches: string[] = [];
  for (const file of scan.textFiles) {
    if (!pattern.test(file.text)) continue;
    const lines = file.text.split(/\r?\n/);
    for (const line of lines) {
      if (pattern.test(line)) {
        matches.push(`${file.relativePath}: ${trim(line.trim())}`);
        if (matches.length >= limit) return matches;
      }
    }
  }
  return matches;
}

function findFilePathMatches(scan: RepoScan, pattern: RegExp, limit = 5): string[] {
  const matches: string[] = [];
  for (const file of scan.textFiles) {
    if (!pattern.test(file.relativePath)) continue;
    matches.push(file.relativePath);
    if (matches.length >= limit) return matches;
  }
  return matches;
}

function hasMatch(scan: RepoScan, pattern: RegExp): boolean {
  return findMatches(scan, pattern, 1).length > 0;
}

function detectApiSurface(scan: RepoScan): boolean {
  return scan.textFiles.some((file) =>
    /\/api\/|export async function (GET|POST|PUT|DELETE)|createServer|NextRequest|Response\.json/.test(file.text),
  );
}

function detectAuthSurface(scan: RepoScan): boolean {
  return scan.textFiles.some((file) =>
    /\bauth\b|\bsession\b|\blogin\b|\bsignIn\b|\brole\b|\bpermission\b/i.test(file.text),
  );
}

function detectDatabaseSurface(scan: RepoScan): boolean {
  return scan.textFiles.some((file) =>
    /\bsqlite\b|\bpostgres\b|\bprisma\b|\bcreate table\b|\bdb\.|\bpool\b|\blibsql\b/i.test(file.text),
  );
}

function detectEmailSurface(scan: RepoScan): boolean {
  return scan.textFiles.some((file) =>
    /\bresend\b|\bnodemailer\b|\bsendgrid\b|\bmailgun\b|\breact-email\b/i.test(file.text),
  );
}

function detectStripeSurface(scan: RepoScan): boolean {
  return scan.textFiles.some((file) =>
    /\bfrom\s+["']stripe["']|\brequire\(["']stripe["']\)|\bnew\s+Stripe\s*\(|\bstripe\.[a-z]/i.test(file.text),
  );
}

function detectResetSurface(scan: RepoScan): boolean {
  return scan.textFiles.some((file) =>
    /\breset password\b|\breset token\b|\bpassword reset\b/i.test(file.text),
  );
}

function detectImageSurface(scan: RepoScan): boolean {
  return scan.textFiles.some((file) =>
    /next\/image|remotePatterns|assetPrefix|cdn|cloudinary|imgix/i.test(file.text),
  );
}

function findHardcodedSecrets(scan: RepoScan): string[] {
  const patterns = [
    /sk_live_[0-9A-Za-z]+/,
    /sk_test_[0-9A-Za-z]+/,
    /\bsk-[A-Za-z0-9]{20,}\b/,
    /\bghp_[A-Za-z0-9]{20,}\b/,
    /\bAIza[0-9A-Za-z\-_]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(api[_-]?key|access[_-]?token|secret[_-]?key|service[_-]?token)\b\s*[:=]\s*['"`][A-Za-z0-9_\-]{24,}['"`]/i,
  ];
  const matches: string[] = [];
  for (const file of scan.textFiles) {
    const lowerPath = file.relativePath.toLowerCase();
    if (lowerPath.includes('.env.example') || lowerPath.includes('example') || lowerPath.includes('sample')) {
      continue;
    }
    const lines = file.text.split(/\r?\n/);
    for (const line of lines) {
      if (patterns.some((pattern) => pattern.test(line))) {
        matches.push(`${file.relativePath}: ${trim(line.trim())}`);
        if (matches.length >= 5) return matches;
      }
    }
  }
  return matches;
}

function buildItems(scan: RepoScan): LaunchCheckItem[] {
  const apiSurface = detectApiSurface(scan);
  const authSurface = detectAuthSurface(scan);
  const dbSurface = detectDatabaseSurface(scan);
  const emailSurface = detectEmailSurface(scan);
  const stripeSurface = detectStripeSurface(scan);
  const resetSurface = detectResetSurface(scan);
  const imageSurface = detectImageSurface(scan);

  const hardcodedSecrets = findHardcodedSecrets(scan);
  const localTokenMatches = findMatches(scan, /\b(localStorage|sessionStorage)\.(setItem|getItem|removeItem)\([^)]*(token|auth|jwt|bearer|refresh[_-]?token|access[_-]?token)/i);
  const sessionExpiryMatches = findMatches(scan, /\b(maxAge|expiresIn|expiresAt|expiry|ttl)\b/i);
  const stripeVerified = findMatches(scan, /\bconstructEvent\b|\bstripe\.webhooks\.constructEvent\b/i);
  const resetExpiry = findMatches(scan, /\b(reset|password).*(expires|expiry|ttl)|\b(expires|expiry|ttl).*(reset|password)/i);
  const asyncEmail = findMatches(scan, /\b(queue|worker|job|background)\b.*\b(email|mail|send)\b|\b(email|mail|send)\b.*\b(queue|worker|job|background)\b/i);
  const inputSanitisation = findMatches(scan, /\bDOMPurify\b|\bsanitize-html\b|\bsanitize\b|\bz\.object\b|\bzod\b|\bvalidator\b/i);
  const errorBoundaries = findMatches(scan, /\berror\.tsx\b|\bErrorBoundary\b|\bcomponentDidCatch\b/i);
  const envValidation = [
    ...findMatches(scan, /\bruntime-env\b|\benvalid\b|\bzod\b.*\b(env|process\.env)\b|\bparseEnv\b|Missing required environment variable/i, 3),
    ...findFilePathMatches(scan, /(^|\/)(env|runtime-env)\.(ts|js|mjs|cjs)$/i, 2),
  ].slice(0, 5);
  const healthChecks = findMatches(scan, /\bhealth-check\b|\/api\/health\b|\b\/health\b|healthz/i);
  const rateLimiting = findMatches(scan, /\brate limit\b|\brateLimit\b|\bthrottle\b|\b429\b/i);
  const pagination = findMatches(scan, /\bcursor\b|\boffset\b|\blimit\b|\bpageSize\b|\bpagination\b/i);
  const indexing = findMatches(scan, /\bCREATE INDEX\b|\b@@index\b|\bindex\(/i);
  const cors = findMatches(scan, /\bAccess-Control-Allow-Origin\b|\bcors\b|\ballowed origins\b/i);
  const dbPooling = findMatches(scan, /\bPool\b|\bconnectionLimit\b|\bpgbouncer\b|\bprisma.*globalThis\b|\bpooled connection\b/i);
  const roleChecks = findMatches(scan, /\brole\b|\bpermission\b|\bauthorize\b|\brequireAuth\b|\bhasRole\b/i);
  const logging = findMatches(scan, /\bconsole\.(log|error|warn)\b|\bpino\b|\bwinston\b|\baudit log\b|\bruntime_event\b/i);
  const backups = findMatches(scan, /\bbackup\b|\brestore\b|\bsnapshot\b|\bdump\b/i);
  const typescript = scan.files.some((file) => /tsconfig(\.[^\\/]+)?\.json$/i.test(file.replace(/\\/g, '/')));
  const cdn = findMatches(scan, /\bremotePatterns\b|\bassetPrefix\b|\bcloudinary\b|\bimgix\b|\bcdn\b/i);

  return [
    createItem(
      'input_sanitisation',
      'Input sanitisation',
      inputSanitisation.length > 0 ? 'pass' : apiSurface ? 'warn' : 'na',
      inputSanitisation.length > 0 ? 'Sanitisation or schema validation patterns were found.' : apiSurface ? 'No clear sanitisation or validation guard was detected.' : 'No obvious API/form surface detected.',
      inputSanitisation,
    ),
    createItem(
      'error_boundaries',
      'Error boundaries',
      errorBoundaries.length > 0 ? 'pass' : 'warn',
      errorBoundaries.length > 0 ? 'Error boundary handling exists.' : 'No explicit React/Next error boundary was detected.',
      errorBoundaries,
    ),
    createItem(
      'no_hardcoded_api_keys',
      'No hardcoded API keys',
      hardcodedSecrets.length > 0 ? 'fail' : 'pass',
      hardcodedSecrets.length > 0 ? 'Potential hardcoded secrets were detected in tracked files.' : 'No obvious hardcoded API keys were found.',
      hardcodedSecrets,
    ),
    createItem(
      'no_tokens_in_local_storage',
      'No tokens in local storage',
      localTokenMatches.length > 0 ? 'fail' : 'pass',
      localTokenMatches.length > 0 ? 'Token-like values appear to be stored in local/session storage.' : 'No token-like local storage usage was detected.',
      localTokenMatches,
    ),
    createItem(
      'sessions_expire',
      'Sessions that expire',
      authSurface ? (sessionExpiryMatches.length > 0 ? 'pass' : 'warn') : 'na',
      authSurface
        ? sessionExpiryMatches.length > 0
          ? 'Session expiry settings were detected.'
          : 'Authentication/session code exists, but explicit expiry settings were not found.'
        : 'No auth/session surface detected.',
      sessionExpiryMatches,
    ),
    createItem(
      'stripe_webhook_verification',
      'Stripe webhook verification',
      stripeSurface ? (stripeVerified.length > 0 ? 'pass' : 'warn') : 'na',
      stripeSurface
        ? stripeVerified.length > 0
          ? 'Stripe webhook signature verification was detected.'
          : 'Stripe usage exists, but webhook signature verification was not obvious.'
        : 'No Stripe integration detected.',
      stripeVerified,
    ),
    createItem(
      'reset_links_expire',
      'Reset links expire',
      resetSurface ? (resetExpiry.length > 0 ? 'pass' : 'warn') : 'na',
      resetSurface
        ? resetExpiry.length > 0
          ? 'Password reset expiry logic was detected.'
          : 'Reset/password flows exist, but expiry rules were not obvious.'
        : 'No reset-password flow detected.',
      resetExpiry,
    ),
    createItem(
      'no_sync_email_sending',
      'No sync email sending',
      emailSurface ? (asyncEmail.length > 0 ? 'pass' : 'warn') : 'na',
      emailSurface
        ? asyncEmail.length > 0
          ? 'Email sending appears to be offloaded to async/background handling.'
          : 'Email integration exists, but async/background delivery was not obvious.'
        : 'No email sending integration detected.',
      asyncEmail,
    ),
    createItem(
      'cdn_for_images',
      'CDN for images',
      imageSurface ? (cdn.length > 0 ? 'pass' : 'warn') : 'na',
      imageSurface
        ? cdn.length > 0
          ? 'Image CDN or remote image configuration was detected.'
          : 'Image handling exists, but CDN configuration was not obvious.'
        : 'No notable image surface detected.',
      cdn,
    ),
    createItem(
      'env_validation',
      'Env validation',
      envValidation.length > 0 ? 'pass' : 'warn',
      envValidation.length > 0 ? 'Environment validation patterns were found.' : 'No explicit env validation layer was detected.',
      envValidation,
    ),
    createItem(
      'health_checks',
      'Health checks',
      healthChecks.length > 0 ? 'pass' : 'warn',
      healthChecks.length > 0 ? 'Health-check endpoints or scripts were found.' : 'No clear health-check endpoint or script was detected.',
      healthChecks,
    ),
    createItem(
      'rate_limiting',
      'Rate limiting',
      rateLimiting.length > 0 ? 'pass' : apiSurface ? 'warn' : 'na',
      rateLimiting.length > 0 ? 'Rate limiting or throttling logic was found.' : apiSurface ? 'API surface exists, but rate limiting was not obvious.' : 'No API surface detected.',
      rateLimiting,
    ),
    createItem(
      'pagination',
      'Pagination',
      pagination.length > 0 ? 'pass' : 'warn',
      pagination.length > 0 ? 'Pagination or cursor-based access patterns were detected.' : 'No clear pagination strategy was detected.',
      pagination,
    ),
    createItem(
      'db_indexing',
      'DB indexing',
      dbSurface ? (indexing.length > 0 ? 'pass' : 'warn') : 'na',
      dbSurface
        ? indexing.length > 0
          ? 'Database indexes were declared in schema or migration code.'
          : 'Database usage exists, but explicit indexing was not obvious.'
        : 'No database surface detected.',
      indexing,
    ),
    createItem(
      'cors_policy',
      'CORS policy',
      apiSurface ? (cors.length > 0 ? 'pass' : 'warn') : 'na',
      apiSurface
        ? cors.length > 0
          ? 'CORS policy handling was detected.'
          : 'API surface exists, but explicit CORS policy was not obvious.'
        : 'No API surface detected.',
      cors,
    ),
    createItem(
      'db_pooling',
      'DB pooling',
      dbSurface ? (dbPooling.length > 0 ? 'pass' : 'warn') : 'na',
      dbSurface
        ? dbPooling.length > 0
          ? 'Database pooling or singleton connection management was detected.'
          : 'Database usage exists, but pooling/singleton connection management was not obvious.'
        : 'No database surface detected.',
      dbPooling,
    ),
    createItem(
      'role_checks',
      'Role checks',
      authSurface ? (roleChecks.length > 0 ? 'pass' : 'warn') : 'na',
      authSurface
        ? roleChecks.length > 0
          ? 'Role or authorization checks were detected.'
          : 'Authentication exists, but role checks were not obvious.'
        : 'No auth surface detected.',
      roleChecks,
    ),
    createItem(
      'logging',
      'Logging',
      logging.length > 0 ? 'pass' : 'warn',
      logging.length > 0 ? 'Logging or audit instrumentation was found.' : 'No substantial logging instrumentation was detected.',
      logging,
    ),
    createItem(
      'backups',
      'Backups',
      backups.length > 0 ? 'pass' : 'warn',
      backups.length > 0 ? 'Backup, snapshot, or restore patterns were found.' : 'No clear backup or restore process was detected.',
      backups,
    ),
    createItem(
      'typescript',
      'TypeScript',
      typescript ? 'pass' : 'fail',
      typescript ? 'TypeScript configuration is present.' : 'No tsconfig was found.',
      typescript ? ['tsconfig.json detected'] : [],
    ),
  ].sort((left, right) => statusPriority(right.status) - statusPriority(left.status) || left.label.localeCompare(right.label));
}

export function getProjectLaunchAudit(projectId: string): LaunchAuditReport {
  const now = Date.now();
  const cached = auditCache.get(projectId);
  if (cached && cached.expiresAt > now) {
    return cached.report;
  }

  const policy = loadProjectPolicy(projectId);
  const scan = scanRepo(policy.repoPath ?? null);
  const items = buildItems(scan);
  const report: LaunchAuditReport = {
    projectId,
    repoPath: policy.repoPath ?? null,
    generatedAt: now,
    summary: {
      pass: items.filter((item) => item.status === 'pass').length,
      warn: items.filter((item) => item.status === 'warn').length,
      fail: items.filter((item) => item.status === 'fail').length,
      na: items.filter((item) => item.status === 'na').length,
    },
    blockers: items.filter((item) => item.status === 'fail').map((item) => item.label),
    items,
  };

  auditCache.set(projectId, {
    expiresAt: now + CACHE_TTL_MS,
    report,
  });

  return report;
}
