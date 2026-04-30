import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AutoresearchCheckResult {
  label: string;
  status: 'pass' | 'fail' | 'unknown';
  detail: string | null;
}

export interface AutoresearchLedgerEntry {
  timestamp: string;
  tag: string;
  profile: string;
  branch: string;
  commit: string;
  status: string;
  score: number;
  durationMs: number;
  changedFiles: number;
  checks: AutoresearchCheckResult[];
  notes: string;
}

export interface AutoresearchLedgerSnapshot {
  generatedAt: number;
  exists: boolean;
  totalRuns: number;
  keepCandidates: number;
  needsRework: number;
  averageScore: number | null;
  latest: AutoresearchLedgerEntry | null;
  entries: AutoresearchLedgerEntry[];
  updatedAt: number | null;
}

interface ReadOptions {
  limit?: number;
}

const HEADER = [
  'timestamp',
  'tag',
  'profile',
  'branch',
  'commit',
  'status',
  'score',
  'duration_ms',
  'changed_files',
  'checks',
  'notes',
] as const;

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

function workspacePath(...segments: string[]): string {
  const direct = resolve(process.cwd(), ...segments);
  if (existsSync(direct)) return direct;
  return resolve(process.cwd(), '..', '..', ...segments);
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || value == null) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function numberValue(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function redactLedgerText(value: string, maxLength = 240): string {
  const redacted = value
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, '[redacted]')
    .replace(/\b(DASHBOARD_AUTH_TOKEN|TURSO_AUTH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)=\S+/gi, '$1=[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}={0,2}/gi, '$1[redacted]')
    .replace(/\b(token=)[A-Za-z0-9._~+/-]{16,}={0,2}/gi, '$1[redacted]');
  const compact = redacted.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3).trimEnd()}...` : compact;
}

function parseChecks(value: string): AutoresearchCheckResult[] {
  return value
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [label = '', status = 'unknown', ...detailParts] = item.split(':');
      const normalizedStatus = status === 'pass' || status === 'fail' ? status : 'unknown';
      const detail = detailParts.length > 0 ? redactLedgerText(detailParts.join(':'), 160) : null;
      return {
        label: redactLedgerText(label, 80),
        status: normalizedStatus,
        detail,
      };
    });
}

function parseEntry(line: string): AutoresearchLedgerEntry | null {
  const cells = line.split('\t');
  if (cells.length < HEADER.length) return null;

  return {
    timestamp: redactLedgerText(cells[0] ?? '', 64),
    tag: redactLedgerText(cells[1] ?? '', 80),
    profile: redactLedgerText(cells[2] ?? '', 24),
    branch: redactLedgerText(cells[3] ?? '', 120),
    commit: redactLedgerText(cells[4] ?? '', 40),
    status: redactLedgerText(cells[5] ?? '', 40),
    score: numberValue(cells[6]),
    durationMs: numberValue(cells[7]),
    changedFiles: numberValue(cells[8]),
    checks: parseChecks(cells[9] ?? ''),
    notes: redactLedgerText(cells.slice(10).join(' '), 260),
  };
}

function emptySnapshot(exists: boolean, updatedAt: number | null): AutoresearchLedgerSnapshot {
  return {
    generatedAt: Date.now(),
    exists,
    totalRuns: 0,
    keepCandidates: 0,
    needsRework: 0,
    averageScore: null,
    latest: null,
    entries: [],
    updatedAt,
  };
}

export function readAutoresearchLedgerFromFile(
  ledgerPath: string,
  options: ReadOptions = {},
): AutoresearchLedgerSnapshot {
  if (!existsSync(ledgerPath)) return emptySnapshot(false, null);

  const updatedAt = Math.round(statSync(ledgerPath).mtimeMs);
  const raw = readFileSync(ledgerPath, 'utf8').trim();
  if (!raw) return emptySnapshot(true, updatedAt);

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const body = lines[0]?.startsWith('timestamp\t') ? lines.slice(1) : lines;
  const parsed = body
    .map(parseEntry)
    .filter((entry): entry is AutoresearchLedgerEntry => entry !== null);

  if (parsed.length === 0) return emptySnapshot(true, updatedAt);

  const entries = [...parsed].reverse();
  const keepCandidates = parsed.filter((entry) => entry.status === 'keep_candidate').length;
  const needsRework = parsed.filter((entry) => entry.status === 'needs_rework').length;
  const averageScore = parsed.reduce((sum, entry) => sum + entry.score, 0) / parsed.length;
  const limit = clampLimit(options.limit);

  return {
    generatedAt: Date.now(),
    exists: true,
    totalRuns: parsed.length,
    keepCandidates,
    needsRework,
    averageScore,
    latest: entries[0] ?? null,
    entries: entries.slice(0, limit),
    updatedAt,
  };
}

export function readAutoresearchLedger(options: ReadOptions = {}): AutoresearchLedgerSnapshot {
  return readAutoresearchLedgerFromFile(
    workspacePath('.tmp', 'autoresearch', 'results.tsv'),
    options,
  );
}
