/**
 * ensure-services.ts — Shared service lifecycle helpers.
 *
 * Provides idempotent start/check functions for StixDB, DB, and daemon.
 * Used by cli.ts and other scripts that need services running before work begins.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { STATE_DIR, DB_PATH, PIDS_DIR } from '../packages/shared/src/state-dir.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DAEMON_STATUS_FILE = path.join(STATE_DIR, 'daemon-status.json');
const DAEMON_STATUS_STALE_MS = 2 * 60 * 1000;
const DASHBOARD_PORT = Number.parseInt(process.env.DASHBOARD_PORT ?? '7391', 10);
const DASHBOARD_HEALTH_URL = `http://127.0.0.1:${DASHBOARD_PORT}/api/health`;
const DASHBOARD_RESTART_MIN_GAP_MS = 60_000;
const DASHBOARD_FAIL_THRESHOLD = 3;
const require = createRequire(import.meta.url);
const TSX_CLI_PATH = require.resolve('tsx/cli');

// Debounce state for dashboard restart. Prevents the tick-every-15s kill/respawn loop.
let dashboardLastRestartMs = 0;
let dashboardConsecutiveFails = 0;

interface ServiceSignature {
  processName?: string;
  commandNeedle?: string;
}

function getServiceSignature(name: string): ServiceSignature | null {
  switch (name) {
    case 'daemon':
      return { processName: 'node.exe', commandNeedle: 'scripts/start-daemon.ts' };
    case 'dashboard':
      return { processName: 'node.exe', commandNeedle: 'packages/dashboard/src/server.ts' };
    case 'stixdb':
      return { processName: 'python.exe', commandNeedle: 'packages/stixdb/start.py' };
    default:
      return null;
  }
}

// Spawn a detached background process. On Windows, uses PowerShell Start-Process -WindowStyle Hidden
// to guarantee no console window flashes. On Unix, uses standard detached spawn.
function spawnHidden(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; stdoutFile?: string; stderrFile?: string },
): { pid: number | undefined } {
  const executable = cmd === 'node' ? process.execPath : cmd;
  const stdoutFd = opts.stdoutFile ? fs.openSync(opts.stdoutFile, 'a') : 'ignore';
  const stderrFd = opts.stderrFile ? fs.openSync(opts.stderrFile, 'a') : 'ignore';
  const child = spawn(executable, args, {
    cwd: opts.cwd,
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    env: opts.env,
    windowsHide: true,
    shell: false,
  });
  const pid = child.pid;
  child.unref();
  return { pid };
}

// Ensure pids directory exists
function ensurePidsDir(): void {
  if (!fs.existsSync(PIDS_DIR)) {
    fs.mkdirSync(PIDS_DIR, { recursive: true });
  }
}

function writePid(name: string, pid: number): void {
  ensurePidsDir();
  fs.writeFileSync(path.join(PIDS_DIR, `${name}.pid`), String(pid));
}

function readPid(name: string): number | null {
  const pidFile = path.join(PIDS_DIR, `${name}.pid`);
  if (!fs.existsSync(pidFile)) return null;
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  return isNaN(pid) ? null : pid;
}

function clearPid(name: string): void {
  const pidFile = path.join(PIDS_DIR, `${name}.pid`);
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
}

function getWindowsProcessInfo(pid: number): { name: string; commandLine: string } | null {
  if (process.platform !== 'win32') return null;
  try {
    const ps = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}";`,
      'if ($p) {',
      '  $p | Select-Object Name, CommandLine | ConvertTo-Json -Compress',
      '}',
    ].join(' ');
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    if (!out) return null;
    const parsed = JSON.parse(out) as { Name?: string; CommandLine?: string };
    return {
      name: parsed.Name ?? '',
      commandLine: parsed.CommandLine ?? '',
    };
  } catch {
    return null;
  }
}

function matchesServiceSignature(pid: number, signature: ServiceSignature): boolean {
  if (process.platform !== 'win32') return true;
  const info = getWindowsProcessInfo(pid);
  if (!info) return false;
  if (signature.processName && info.name.toLowerCase() !== signature.processName.toLowerCase()) {
    return false;
  }
  if (signature.commandNeedle && !info.commandLine.includes(signature.commandNeedle)) {
    return false;
  }
  return true;
}

function readDaemonStatusUpdatedAt(): number | null {
  if (!fs.existsSync(DAEMON_STATUS_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(DAEMON_STATUS_FILE, 'utf8')) as { updatedAt?: string };
    if (!raw.updatedAt) return null;
    const parsed = Date.parse(raw.updatedAt);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isDaemonStatusFresh(maxAgeMs = DAEMON_STATUS_STALE_MS): boolean {
  const updatedAt = readDaemonStatusUpdatedAt();
  return updatedAt !== null && (Date.now() - updatedAt) <= maxAgeMs;
}

function nextServiceLogPaths(name: string): { stdoutFile: string; stderrFile: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  return {
    stdoutFile: path.join(STATE_DIR, `${name}-${stamp}.out.log`),
    stderrFile: path.join(STATE_DIR, `${name}-${stamp}.err.log`),
  };
}

function findWindowsPid(commandNeedle: string, processName?: string): number | null {
  if (process.platform !== 'win32') return null;
  try {
    const escaped = commandNeedle.replace(/'/g, "''");
    const nameClause = processName
      ? ` -and $_.Name -ieq '${processName.replace(/'/g, "''")}'`
      : '';
    const ps = [
      '$p = Get-CimInstance Win32_Process |',
      `  Where-Object { $_.CommandLine -like '*${escaped}*'${nameClause} -and $_.CommandLine -notlike '*Get-CimInstance Win32_Process*' } |`,
      '  Sort-Object CreationDate -Descending |',
      '  Select-Object -First 1 -ExpandProperty ProcessId;',
      'if ($p) { $p }',
    ].join(' ');
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    const pid = Number.parseInt(out, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function findWindowsPidListeningOnPort(port: number): number | null {
  if (process.platform !== 'win32') return null;
  try {
    const ps = [
      `$conn = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;`,
      'if ($conn) { $conn.OwningProcess }',
    ].join(' ');
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    const pid = Number.parseInt(out, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

// --- Process checks ---

export function isProcessRunning(pid: number): boolean {
  try {
    // On Windows, tasklist; on Unix, kill -0
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return out.includes(String(pid));
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}

export function isPidAlive(name: string): boolean {
  const pid = readPid(name);
  if (pid === null) return false;
  if (isProcessRunning(pid)) {
    const signature = getServiceSignature(name);
    if (!signature || matchesServiceSignature(pid, signature)) {
      return true;
    }
  }
  // Stale PID file — clean up
  clearPid(name);
  return false;
}

// --- Database ---

export async function ensureDB(): Promise<void> {
  // Ensure state dir exists
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }

  if (fs.existsSync(DB_PATH)) return;

  // Run migrations by importing getDb (it runs migrations internally)
  console.log('  Initializing database...');
  const { getDb } = await import('../packages/core/src/task-queue.js');
  getDb();
  console.log('  Database ready.');
}

// --- StixDB ---

async function fetchHealth(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForStableDashboardHealth(expectedPid: number | null, checks = 2): Promise<boolean> {
  for (let index = 0; index < checks; index++) {
    const healthy = await fetchHealth(DASHBOARD_HEALTH_URL);
    if (!healthy) return false;
    if (expectedPid !== null && !isProcessRunning(expectedPid)) return false;
    if (index < checks - 1) {
      await sleep(500);
    }
  }
  return true;
}

export async function ensureStixDB(): Promise<boolean> {
  // Already running?
  if (await fetchHealth('http://localhost:4020/health')) return true;

  // Check PID file — if alive, wait a moment (might be starting)
  if (isPidAlive('stixdb')) {
    console.log('  StixDB process found, waiting for health...');
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      if (await fetchHealth('http://localhost:4020/health')) return true;
    }
    console.log('  StixDB process alive but not responding. Continuing without it.');
    return false;
  }

  // Start StixDB
  console.log('  Starting StixDB...');
  try {
    const { pid } = spawnHidden('python', [path.join(ROOT, 'packages/stixdb/start.py')], {
      cwd: ROOT,
      env: { ...process.env },
    });

    if (pid) {
      writePid('stixdb', pid);
    }

    // Wait for health (45s — first run downloads embedding model)
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      if (await fetchHealth('http://localhost:4020/health')) {
        console.log('  StixDB ready on :4020');
        return true;
      }
    }

    console.log('  StixDB did not become healthy in 45s. Continuing without it.');
    return false;
  } catch (err) {
    console.log(`  StixDB failed to start: ${err}. Continuing without it.`);
    return false;
  }
}

// --- Daemon ---

export async function ensureDaemon(): Promise<void> {
  const pidFromFile = readPid('daemon');
  const discoveredPid = pidFromFile ?? findWindowsPid('scripts/start-daemon.ts', 'node.exe');
  if (discoveredPid !== null && isProcessRunning(discoveredPid)) {
    if (!pidFromFile) {
      writePid('daemon', discoveredPid);
    }
    if (isDaemonStatusFresh()) {
      console.log('  Daemon already running.');
      return;
    }

    console.log('  Daemon process found but status is stale. Restarting it cleanly...');
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /PID ${discoveredPid} /T /F`, { stdio: 'ignore' });
      } catch {
        // Best effort; start below will surface any real conflict.
      }
    } else {
      try {
        process.kill(discoveredPid, 'SIGTERM');
      } catch {
        // Best effort.
      }
    }
    clearPid('daemon');
    await sleep(1500);
  }

  console.log('  Starting daemon...');
  const logs = nextServiceLogPaths('daemon');
  const { pid } = spawnHidden(
    process.execPath,
    [TSX_CLI_PATH, '--experimental-sqlite', path.join(ROOT, 'scripts/start-daemon.ts')],
    { cwd: ROOT, env: { ...process.env }, ...logs },
  );

  if (pid) {
    writePid('daemon', pid);
  } else {
    const discoveredPid = findWindowsPid('scripts/start-daemon.ts', 'node.exe');
    if (discoveredPid) {
      writePid('daemon', discoveredPid);
    }
  }

  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (isDaemonStatusFresh()) {
      console.log('  Daemon started.');
      return;
    }
  }

  console.log(`  Daemon did not report a fresh heartbeat in time. Check ${logs.stdoutFile} and ${logs.stderrFile}.`);
}

// --- Dashboard ---

export async function ensureDashboard(): Promise<void> {
  if (await fetchHealth(DASHBOARD_HEALTH_URL, 5000)) {
    dashboardConsecutiveFails = 0;
    const discoveredPid = readPid('dashboard') ?? findWindowsPid('packages/dashboard/src/server.ts', 'node.exe');
    if (discoveredPid) {
      writePid('dashboard', discoveredPid);
    }
    console.log('  Dashboard already running.');
    return;
  }

  dashboardConsecutiveFails += 1;
  const sinceLastRestart = Date.now() - dashboardLastRestartMs;

  const pidFromFile = readPid('dashboard');
  const discoveredPid = pidFromFile ?? findWindowsPid('packages/dashboard/src/server.ts', 'node.exe');
  const processAlive = discoveredPid !== null && isProcessRunning(discoveredPid);

  if (processAlive && (dashboardConsecutiveFails < DASHBOARD_FAIL_THRESHOLD || sinceLastRestart < DASHBOARD_RESTART_MIN_GAP_MS)) {
    console.log(`  Dashboard health check failed (${dashboardConsecutiveFails}/${DASHBOARD_FAIL_THRESHOLD}), process still alive. Holding restart (${Math.max(0, DASHBOARD_RESTART_MIN_GAP_MS - sinceLastRestart) / 1000}s until next restart allowed).`);
    return;
  }

  if (processAlive) {
    if (!pidFromFile) {
      writePid('dashboard', discoveredPid!);
    }
    console.log(`  Dashboard unhealthy for ${dashboardConsecutiveFails} consecutive checks. Restarting it cleanly...`);
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /PID ${discoveredPid} /T /F`, { stdio: 'ignore' });
      } catch {
        // Best effort; a later health check will confirm whether a conflict remains.
      }
    } else {
      try {
        process.kill(discoveredPid!, 'SIGTERM');
      } catch {
        // Best effort.
      }
    }
    clearPid('dashboard');
    await sleep(1500);
  }

  const portPid = findWindowsPidListeningOnPort(DASHBOARD_PORT);
  if (portPid !== null) {
    const signature = getServiceSignature('dashboard');
    if (signature && matchesServiceSignature(portPid, signature)) {
      console.log(`  Dashboard port ${DASHBOARD_PORT} is owned by a stale dashboard process. Reclaiming it...`);
      try {
        execSync(`taskkill /PID ${portPid} /T /F`, { stdio: 'ignore' });
      } catch {
        // Best effort; health polling below will reveal whether the conflict remains.
      }
      await sleep(1500);
    } else {
      console.log(`  Dashboard port ${DASHBOARD_PORT} is occupied by another process (PID ${portPid}).`);
      return;
    }
  }

  console.log('  Starting dashboard...');
  const logs = nextServiceLogPaths('dashboard');
  const { pid } = spawnHidden(
    process.execPath,
    [TSX_CLI_PATH, '--experimental-sqlite', path.join(ROOT, 'packages/dashboard/src/server.ts')],
    { cwd: ROOT, env: { ...process.env }, ...logs },
  );

  if (pid) {
    writePid('dashboard', pid);
  } else {
    const discoveredPid = findWindowsPid('packages/dashboard/src/server.ts', 'node.exe');
    if (discoveredPid) {
      writePid('dashboard', discoveredPid);
    }
  }

  dashboardLastRestartMs = Date.now();

  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const expectedPid = readPid('dashboard');
    if (await waitForStableDashboardHealth(expectedPid)) {
      dashboardConsecutiveFails = 0;
      console.log(`  Dashboard started on :${DASHBOARD_PORT}`);
      return;
    }
  }

  console.log(`  Dashboard did not become healthy in time. Check ${logs.stdoutFile} and ${logs.stderrFile}.`);
}

// --- Kill helpers ---

export function killService(name: string): boolean {
  const pid = readPid(name) ?? (
    name === 'daemon'
      ? findWindowsPid('scripts/start-daemon.ts', 'node.exe')
      : name === 'dashboard'
        ? findWindowsPid('packages/dashboard/src/server.ts', 'node.exe')
        : name === 'stixdb'
          ? findWindowsPid('packages/stixdb/start.py', 'python.exe')
          : null
  );
  if (pid === null) return false;

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    clearPid(name);
    return true;
  } catch {
    clearPid(name);
    return false;
  }
}

export function killAll(): void {
  for (const svc of ['daemon', 'dashboard', 'stixdb']) {
    const killed = killService(svc);
    if (killed) console.log(`  Stopped ${svc}`);
    else console.log(`  ${svc} was not running`);
  }
}

// --- Service status ---

export interface ServiceStatus {
  name: string;
  running: boolean;
  pid: number | null;
}

export function getServiceStatuses(): ServiceStatus[] {
  return ['stixdb', 'daemon', 'dashboard'].map((name) => ({
    name,
    running: isPidAlive(name),
    pid: readPid(name),
  }));
}

// --- Utility ---

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log('Ensuring Organism services...');
  await ensureDB();
  await ensureStixDB();
  await ensureDashboard();
  await ensureDaemon();
  console.log('Service bootstrap complete.');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error('ensure-services failed:', error);
    process.exitCode = 1;
  });
}
