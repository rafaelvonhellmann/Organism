/**
 * Organism autoresearch evaluation harness.
 *
 * This is the Organism analogue of autoresearch's fixed-budget metric loop:
 * run one candidate through a stable set of checks and append the outcome to
 * an untracked TSV ledger.
 *
 * Usage:
 *   node node_modules/tsx/dist/cli.mjs --experimental-sqlite scripts/autoresearch-organism.ts --tag apr29 --notes "baseline"
 *   node node_modules/tsx/dist/cli.mjs --experimental-sqlite scripts/autoresearch-organism.ts --profile full --tag apr29
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

type Profile = 'quick' | 'full';

interface Check {
  label: string;
  command: string;
  args: string[];
  timeoutMs: number;
}

interface CheckResult {
  label: string;
  status: 'pass' | 'fail';
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
}

interface Options {
  profile: Profile;
  tag: string;
  notes: string;
  resultsPath: string;
  listChecks: boolean;
}

const ROOT = path.resolve(import.meta.dirname, '..');
const node = process.execPath;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const quickChecks: Check[] = [
  {
    label: 'TypeScript',
    command: node,
    args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'],
    timeoutMs: 120_000,
  },
  {
    label: 'Core autoresearch slice',
    command: node,
    args: [
      'node_modules/tsx/dist/cli.mjs',
      '--experimental-sqlite',
      '--test',
      'packages/core/src/agent-brain.test.ts',
      'packages/core/src/registry.test.ts',
      'packages/core/src/run-recovery.test.ts',
      'packages/core/src/run-state.test.ts',
      'packages/core/src/runtime-auth.test.ts',
      'packages/core/src/scheduler.test.ts',
    ],
    timeoutMs: 180_000,
  },
  {
    label: 'Dashboard auth',
    command: node,
    args: ['node_modules/tsx/dist/cli.mjs', '--test', 'packages/dashboard-v2/src/lib/auth.test.ts'],
    timeoutMs: 60_000,
  },
];

const fullChecks: Check[] = [
  ...quickChecks,
  {
    label: 'Dashboard build',
    command: npm,
    args: ['--prefix', 'packages/dashboard-v2', 'run', 'build'],
    timeoutMs: 180_000,
  },
];

function defaultTag(): string {
  const now = new Date();
  return [
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    profile: 'quick',
    tag: process.env.ORGANISM_AUTORESEARCH_TAG ?? defaultTag(),
    notes: '',
    resultsPath: process.env.ORGANISM_AUTORESEARCH_RESULTS ?? path.join(ROOT, '.tmp', 'autoresearch', 'results.tsv'),
    listChecks: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--profile') {
      if (next !== 'quick' && next !== 'full') {
        throw new Error('--profile must be quick or full');
      }
      options.profile = next;
      i += 1;
      continue;
    }
    if (arg === '--tag') {
      if (!next) throw new Error('--tag requires a value');
      options.tag = next;
      i += 1;
      continue;
    }
    if (arg === '--notes') {
      if (!next) throw new Error('--notes requires a value');
      options.notes = next;
      i += 1;
      continue;
    }
    if (arg === '--results') {
      if (!next) throw new Error('--results requires a value');
      options.resultsPath = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--list-checks') {
      options.listChecks = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function checksForProfile(profile: Profile): Check[] {
  return profile === 'full' ? fullChecks : quickChecks;
}

function runGit(args: string[], fallback = ''): string {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return fallback;
  return result.stdout.trim();
}

function changedFileCount(): number {
  const status = runGit(['status', '--porcelain'], '');
  if (!status) return 0;
  return status.split(/\r?\n/).filter(Boolean).length;
}

function runCheck(check: Check): CheckResult {
  const started = Date.now();
  console.log(`\n--- ${check.label} ---`);
  console.log([check.command, ...check.args].join(' '));

  const result = spawnSync(check.command, check.args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: check.timeoutMs,
    windowsHide: true,
  });

  const durationMs = Date.now() - started;
  const error = result.error ? result.error.message : null;
  const status = result.status === 0 && !error ? 'pass' : 'fail';
  console.log(`${status === 'pass' ? 'PASS' : 'FAIL'} ${check.label} (${durationMs}ms)`);

  return {
    label: check.label,
    status,
    durationMs,
    exitCode: result.status,
    signal: result.signal,
    error,
  };
}

function tsv(value: unknown): string {
  return String(value ?? '')
    .replace(/\t/g, ' ')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function appendLedger(options: Options, results: CheckResult[]): void {
  const passed = results.filter((result) => result.status === 'pass').length;
  const total = results.length;
  const score = total === 0 ? 0 : passed / total;
  const durationMs = results.reduce((sum, result) => sum + result.durationMs, 0);
  const status = passed === total ? 'keep_candidate' : 'needs_rework';
  const checks = results
    .map((result) => `${result.label}:${result.status}${result.error ? `:${result.error}` : ''}`)
    .join('; ');
  const row = [
    new Date().toISOString(),
    options.tag,
    options.profile,
    runGit(['branch', '--show-current'], 'unknown'),
    runGit(['rev-parse', '--short', 'HEAD'], 'unknown'),
    status,
    score.toFixed(3),
    durationMs,
    changedFileCount(),
    checks,
    options.notes,
  ].map(tsv).join('\t');

  fs.mkdirSync(path.dirname(options.resultsPath), { recursive: true });
  if (!fs.existsSync(options.resultsPath)) {
    fs.writeFileSync(
      options.resultsPath,
      'timestamp\ttag\tprofile\tbranch\tcommit\tstatus\tscore\tduration_ms\tchanged_files\tchecks\tnotes\n',
      'utf8',
    );
  }
  fs.appendFileSync(options.resultsPath, `${row}\n`, 'utf8');
  console.log(`\nLedger appended: ${options.resultsPath}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const checks = checksForProfile(options.profile);

  if (options.listChecks) {
    for (const check of checks) {
      console.log(`${check.label}\t${check.command} ${check.args.join(' ')}`);
    }
    return;
  }

  console.log('\n============================================');
  console.log('Organism Autoresearch Evaluation');
  console.log('============================================');
  console.log(`Tag: ${options.tag}`);
  console.log(`Profile: ${options.profile}`);
  console.log(`Branch: ${runGit(['branch', '--show-current'], 'unknown')}`);
  console.log(`Commit: ${runGit(['rev-parse', '--short', 'HEAD'], 'unknown')}`);
  console.log(`Changed files: ${changedFileCount()}`);

  const results = checks.map(runCheck);
  appendLedger(options, results);

  const failed = results.filter((result) => result.status === 'fail');
  if (failed.length > 0) {
    console.error(`\nAutoresearch candidate needs rework: ${failed.map((result) => result.label).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nAutoresearch candidate passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
