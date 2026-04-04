/**
 * ensure-services.ts — Shared service lifecycle helpers.
 *
 * Provides idempotent start/check functions for StixDB, DB, and daemon.
 * Used by cli.ts and other scripts that need services running before work begins.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const PIDS_DIR = path.join(STATE_DIR, 'pids');
const DB_PATH = path.join(STATE_DIR, 'tasks.db');

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
  if (isProcessRunning(pid)) return true;
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
    const child = spawn('python', [path.join(ROOT, 'packages/stixdb/start.py')], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });

    if (child.pid) {
      writePid('stixdb', child.pid);
      child.unref();
    }

    // Wait for health
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      if (await fetchHealth('http://localhost:4020/health')) {
        console.log('  StixDB ready on :4020');
        return true;
      }
    }

    console.log('  StixDB did not become healthy in 15s. Continuing without it.');
    return false;
  } catch (err) {
    console.log(`  StixDB failed to start: ${err}. Continuing without it.`);
    return false;
  }
}

// --- Daemon ---

export async function ensureDaemon(): Promise<void> {
  if (isPidAlive('daemon')) {
    console.log('  Daemon already running.');
    return;
  }

  console.log('  Starting daemon...');
  const child = spawn(
    'node',
    ['--import', 'tsx', '--experimental-sqlite', path.join(ROOT, 'scripts/start-daemon.ts')],
    {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    },
  );

  if (child.pid) {
    writePid('daemon', child.pid);
    child.unref();
  }

  // Brief wait to let it start
  await sleep(2000);
  console.log('  Daemon started.');
}

// --- Dashboard ---

export async function ensureDashboard(): Promise<void> {
  if (isPidAlive('dashboard')) {
    console.log('  Dashboard already running.');
    return;
  }

  console.log('  Starting dashboard...');
  const child = spawn(
    'node',
    ['--import', 'tsx', '--experimental-sqlite', path.join(ROOT, 'packages/dashboard/src/server.ts')],
    {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    },
  );

  if (child.pid) {
    writePid('dashboard', child.pid);
    child.unref();
  }

  await sleep(1000);
  console.log('  Dashboard started on :7391');
}

// --- Kill helpers ---

export function killService(name: string): boolean {
  const pid = readPid(name);
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
