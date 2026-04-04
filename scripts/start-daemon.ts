/**
 * start-daemon.ts — Main entry point for running Organism autonomously.
 *
 * Usage: pnpm start
 * Or:    tsx --experimental-sqlite scripts/start-daemon.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { requireSecrets } from '../packages/shared/src/secrets.js';
import { getDb } from '../packages/core/src/task-queue.js';
import { loadRegistry } from '../packages/core/src/registry.js';
import { startScheduler } from '../packages/core/src/scheduler.js';
import { startDaemon } from '../packages/core/src/agent-runner.js';
import dashboardServer from '../packages/dashboard/src/server.js';

const VERSION = '0.1.0';
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? '7391');
const DAEMON_POLL_MS = 10_000;   // 10 seconds — agent runner polling interval
const SCHEDULER_TICK_MS = 60_000; // 60 seconds — scheduler tick interval

// --- Health check ---

function runHealthCheck(): void {
  const REQUIRED_SECRETS = ['ANTHROPIC_API_KEY'];
  console.log('\n=== Organism Health Check ===\n');

  let allOk = true;

  // Secrets
  process.stdout.write('Secrets: ');
  try {
    requireSecrets(REQUIRED_SECRETS);
    console.log('OK');
  } catch (err) {
    console.log(`FAIL — ${err}`);
    allOk = false;
  }

  // State directory
  process.stdout.write('State directory: ');
  const stateDir = path.resolve(process.cwd(), 'state');
  if (fs.existsSync(stateDir)) {
    console.log('OK');
  } else {
    fs.mkdirSync(stateDir, { recursive: true });
    console.log('Created');
  }

  // Database + migrations
  process.stdout.write('Database (tasks.db): ');
  try {
    const db = getDb(); // getDb() runs runMigrations() internally
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (row) {
      console.log('OK');
    } else {
      console.log('FAIL — tasks table missing after migration');
      allOk = false;
    }
  } catch (err) {
    console.log(`FAIL — ${err}`);
    allOk = false;
  }

  // Capability registry
  process.stdout.write('Capability registry: ');
  const registryPath = path.resolve(process.cwd(), 'knowledge/capability-registry.json');
  if (fs.existsSync(registryPath)) {
    try {
      const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { capabilities: Array<{ status: string }> };
      const activeCount = reg.capabilities.filter((c) => c.status === 'active').length;
      console.log(`OK (${activeCount} active agents)`);
    } catch {
      console.log('FAIL — invalid JSON');
      allOk = false;
    }
  } else {
    console.log('FAIL — file not found');
    allOk = false;
  }

  // OpenAI (optional)
  process.stdout.write('OpenAI API key (optional): ');
  console.log(process.env.OPENAI_API_KEY ? 'Present' : 'Missing — Codex Review will not function');

  console.log('');

  if (!allOk) {
    console.error('Health check failed. Fix the issues above before running Organism.');
    process.exit(1);
  }
  console.log('Health check passed.\n');
}

// --- Startup banner ---

function printBanner(): void {
  const capabilities = loadRegistry();
  const activeAgents = capabilities.filter((c) => c.status === 'active').map((c) => c.owner);
  const shadowAgents = capabilities.filter((c) => c.status === 'shadow').map((c) => c.owner);
  const uniqueActive = [...new Set(activeAgents)];
  const uniqueShadow = [...new Set(shadowAgents)];

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║            O R G A N I S M                  ║');
  console.log(`║  Autonomous Multi-Agent Company  v${VERSION}      ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Started:    ${new Date().toISOString()}`);
  console.log(`  Dashboard:  http://localhost:${DASHBOARD_PORT}`);
  console.log(`  Active agents (${uniqueActive.length}): ${uniqueActive.join(', ') || 'none'}`);
  console.log(`  Shadow agents (${uniqueShadow.length}): ${uniqueShadow.join(', ') || 'none'}`);
  console.log('');
}

// --- Main ---

async function main(): Promise<void> {
  // 1. Health check — exits if critical secrets missing
  runHealthCheck();

  // 2. Startup banner
  printBanner();

  // 3. Dashboard is started by importing the server module (it calls server.listen() on import)
  //    Port is already logged by the dashboard module. Just confirm here.
  console.log(`[Daemon] Dashboard running on port ${DASHBOARD_PORT}`);

  // 4. Migrations already run inside getDb() (called during health check above).
  console.log('[Daemon] Database migrations OK');

  // 5. Start scheduler (60s tick)
  const schedulerHandle = startScheduler(SCHEDULER_TICK_MS);
  console.log(`[Daemon] Scheduler started (tick: ${SCHEDULER_TICK_MS / 1000}s)`);

  // 6. Start agent runner daemon (10s poll)
  const daemonHandle = startDaemon(DAEMON_POLL_MS);
  console.log(`[Daemon] Agent runner started (poll: ${DAEMON_POLL_MS / 1000}s)`);

  // 7. Graceful shutdown
  function shutdown(signal: string): void {
    console.log(`\n[Daemon] Received ${signal} — shutting down gracefully...`);
    clearInterval(schedulerHandle);
    clearInterval(daemonHandle);
    dashboardServer.close(() => {
      console.log('[Daemon] Dashboard closed.');
    });
    console.log('[Daemon] Organism stopped. Goodbye.');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 8. Ready message
  console.log('\nOrganism is running. Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('[Daemon] Fatal startup error:', err);
  process.exit(1);
});
