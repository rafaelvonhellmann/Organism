/**
 * cli.ts — The single entry point for talking to Organism.
 *
 * Usage:
 *   npm run organism "review synapse"
 *   npm run organism "deploy"
 *   npm run organism "morning brief"
 *   npm run organism "status"
 *   npm run organism "build auth page for synapse"
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ensureDB,
  ensureStixDB,
  ensureDaemon,
  ensureDashboard,
  killAll,
  getServiceStatuses,
  isPidAlive,
} from './ensure-services.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');

// ── Command routing ──────────────────────────────────────────────────────────

interface Route {
  patterns: RegExp[];
  handler: string;
}

const ROUTES: Route[] = [
  // System commands
  { patterns: [/^deploy$/i, /^start$/i, /^boot$/i, /^up$/i], handler: 'deploy' },
  { patterns: [/^stop$/i, /^shutdown$/i, /^down$/i, /^kill$/i], handler: 'stop' },
  { patterns: [/^status$/i, /^health$/i, /^check$/i], handler: 'status' },
  { patterns: [/morning.?brief/i, /^brief$/i], handler: 'morning-brief' },

  // Review commands
  { patterns: [/review\s+synapse/i, /synapse\s+review/i], handler: 'review-synapse' },

  // Catch-all: submit as a task to the orchestrator
  { patterns: [/.*/], handler: 'submit-task' },
];

function matchRoute(input: string): { handler: string; match: RegExpMatchArray } {
  for (const route of ROUTES) {
    for (const pattern of route.patterns) {
      const m = input.match(pattern);
      if (m) return { handler: route.handler, match: m };
    }
  }
  // Unreachable due to catch-all, but TypeScript needs it
  return { handler: 'submit-task', match: input.match(/.*/)! };
}

// ── Spinner ──────────────────────────────────────────────────────────────────

function startSpinner(message: string): { stop: (final?: string) => void; update: (msg: string) => void } {
  const frames = ['|', '/', '-', '\\'];
  let i = 0;
  let currentMsg = message;

  const interval = setInterval(() => {
    process.stdout.write(`\r  ${frames[i % frames.length]} ${currentMsg}`);
    i++;
  }, 120);

  return {
    update(msg: string) { currentMsg = msg; },
    stop(final?: string) {
      clearInterval(interval);
      process.stdout.write(`\r  ${final ?? currentMsg}${' '.repeat(20)}\n`);
    },
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleDeploy(): Promise<void> {
  console.log('\n  Booting Organism...\n');

  await ensureDB();
  const stixOk = await ensureStixDB();
  await ensureDashboard();
  await ensureDaemon();

  // Count agents from registry
  let agentCount = 0;
  try {
    const regPath = path.join(ROOT, 'knowledge/capability-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8')) as { capabilities: Array<{ status: string; owner: string }> };
    const active = reg.capabilities.filter((c) => c.status === 'active');
    agentCount = new Set(active.map((c) => c.owner)).size;
  } catch { /* ignore */ }

  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║            O R G A N I S M                  ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log(`  Organism is alive. ${agentCount} agents ready.`);
  console.log(`  StixDB:    ${stixOk ? 'http://localhost:4020' : 'unavailable'}`);
  console.log('  Dashboard: http://localhost:7391');
  console.log('  Daemon:    running');
  console.log('');
}

async function handleStop(): Promise<void> {
  console.log('\n  Shutting down Organism...\n');
  killAll();
  console.log('\n  Organism stopped.\n');
}

async function handleStatus(): Promise<void> {
  console.log('\n  === Organism Status ===\n');

  // Services
  const services = getServiceStatuses();
  for (const svc of services) {
    const icon = svc.running ? '[UP]' : '[--]';
    const pidStr = svc.pid ? ` (PID ${svc.pid})` : '';
    console.log(`  ${icon} ${svc.name}${pidStr}`);
  }

  // Task/spend/gate info (requires DB)
  try {
    await ensureDB();

    const { getPendingTasks, getDeadLetterTasks } = await import('../packages/core/src/task-queue.js');
    const { getSystemSpend } = await import('../packages/core/src/budget.js');
    const { getPendingG4Gates } = await import('../packages/core/src/gates.js');

    const pending = getPendingTasks();
    const deadLetters = getDeadLetterTasks();
    const spend = getSystemSpend();

    console.log('');
    console.log(`  Pending tasks:  ${pending.length}`);
    console.log(`  Dead letters:   ${deadLetters.length}`);
    console.log(`  Today's spend:  $${spend.toFixed(4)}`);

    let gates: ReturnType<typeof getPendingG4Gates> = [];
    try { gates = getPendingG4Gates(); } catch { /* table might not exist */ }
    if (gates.length > 0) {
      console.log(`  Pending G4:     ${gates.length} gate(s) awaiting Rafael`);
    }
  } catch (err) {
    console.log(`\n  (Could not read task data: ${err})`);
  }

  console.log('');
}

async function handleMorningBrief(): Promise<void> {
  await ensureDB();
  // Import and run morning brief inline rather than spawning a subprocess
  // This avoids process management complexity and gives us the output directly
  const briefModule = await import('./morning-brief.js');
  // morning-brief.ts runs on import (try/catch at bottom of file)
  // The import itself executes the brief since it calls renderBrief() at module level
}

async function handleReviewSynapse(): Promise<void> {
  console.log('\n  === Synapse Full Review ===\n');

  // Ensure infrastructure
  console.log('  Ensuring services...');
  await ensureDB();
  await ensureStixDB();

  // Reset DB for clean review
  console.log('  Resetting task database for clean review...');
  const dbPath = path.join(STATE_DIR, 'tasks.db');
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  await ensureDB();

  console.log('  Launching 20-agent review pipeline...\n');

  // Dynamically import and run review-synapse
  // We need to import the orchestrator and agent runner fresh after DB reset
  const { submitTask } = await import('../packages/core/src/orchestrator.js');
  const { dispatchPendingTasks } = await import('../packages/core/src/agent-runner.js');

  // Re-import review-synapse logic by importing the module
  // (it runs on import)
  const startTime = Date.now();

  // Instead of importing the module (which runs immediately with its own console output),
  // we just let it execute — the review-synapse.ts script handles everything
  await import('./review-synapse.js');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Save full output
  // The review script already outputs everything to console.
  // We capture summary info from the DB.
  try {
    const { getDb } = await import('../packages/core/src/task-queue.js');
    const { getSystemSpend } = await import('../packages/core/src/budget.js');
    const db = getDb();
    const tasks = db.prepare("SELECT * FROM tasks WHERE project_id = 'synapse' ORDER BY created_at").all() as Array<{
      id: string; agent: string; status: string; description: string; output: string; cost_usd: number;
    }>;

    let report = `Synapse Review — ${new Date().toISOString()}\n`;
    report += `Elapsed: ${elapsed}s\n`;
    report += `Total cost: $${getSystemSpend().toFixed(4)}\n\n`;

    for (const task of tasks) {
      report += `--- ${task.agent} (${task.status}) ---\n`;
      if (task.output) {
        try {
          const out = JSON.parse(task.output) as Record<string, unknown>;
          const text = (out.text as string) ?? (out.implementation as string) ?? (out.report as string) ?? '';
          report += text + '\n\n';
        } catch {
          report += String(task.output).slice(0, 2000) + '\n\n';
        }
      }
    }

    const outputPath = path.join(STATE_DIR, 'synapse-review-full.txt');
    fs.writeFileSync(outputPath, report, 'utf8');
    console.log(`\n  Full report saved to ${outputPath}`);
  } catch {
    // Non-critical — review output was already printed to console
  }

  console.log(`\n  Review completed in ${elapsed}s.\n`);
}

async function handleSubmitTask(input: string): Promise<void> {
  console.log('\n  Submitting task to Organism...\n');

  // Ensure services
  await ensureDB();
  await ensureStixDB();

  const { submitTask } = await import('../packages/core/src/orchestrator.js');
  const { dispatchPendingTasks } = await import('../packages/core/src/agent-runner.js');
  const { getTask } = await import('../packages/core/src/task-queue.js');
  const { getSystemSpend } = await import('../packages/core/src/budget.js');

  // Submit the natural language input as a task
  const taskId = await submitTask(
    { description: input, input: { userCommand: input } },
    {},
  );

  console.log(`  Task created: ${taskId.slice(0, 8)}`);

  // Dispatch loop — keep running until this task completes or max rounds
  const spinner = startSpinner('Processing...');
  const maxRounds = 30;
  let round = 0;

  while (round < maxRounds) {
    round++;
    const task = getTask(taskId);
    if (!task) break;

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'dead_letter') {
      spinner.stop(`${task.status === 'completed' ? 'Done' : 'Task ' + task.status}`);

      // Print output
      if (task.output) {
        const out = task.output as Record<string, unknown>;
        const text = (out.text as string) ?? (out.implementation as string) ?? (out.report as string) ?? (out.summary as string) ?? '';
        if (text) {
          console.log('');
          console.log(text);
        } else {
          console.log('');
          console.log(JSON.stringify(task.output, null, 2));
        }
      }

      if (task.status === 'failed') {
        console.log(`\n  Error: ${task.error ?? 'unknown'}`);
      }

      console.log(`\n  Cost: $${(task.costUsd ?? 0).toFixed(4)} | Total spend: $${getSystemSpend().toFixed(4)}`);
      return;
    }

    spinner.update(`Processing (round ${round}, status: ${task.status})...`);
    await dispatchPendingTasks();
    await sleep(500);
  }

  spinner.stop('Timed out');
  console.log(`\n  Task ${taskId.slice(0, 8)} did not complete in ${maxRounds} rounds.`);
  console.log('  It may still be processing. Run: npm run organism "status"');
  console.log(`\n  Spend so far: $${getSystemSpend().toFixed(4)}\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const input = args.join(' ').trim();

  if (!input) {
    printUsage();
    return;
  }

  const { handler } = matchRoute(input);

  try {
    switch (handler) {
      case 'deploy':        await handleDeploy(); break;
      case 'stop':          await handleStop(); break;
      case 'status':        await handleStatus(); break;
      case 'morning-brief': await handleMorningBrief(); break;
      case 'review-synapse': await handleReviewSynapse(); break;
      case 'submit-task':   await handleSubmitTask(input); break;
      default:              await handleSubmitTask(input); break;
    }
  } catch (err) {
    console.error(`\n  Organism error: ${err}\n`);
    process.exit(1);
  }
}

function printUsage(): void {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║            O R G A N I S M                  ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  Usage: npm run organism "<command>"');
  console.log('');
  console.log('  System:');
  console.log('    deploy / start / boot    Start all services');
  console.log('    stop / shutdown           Stop all services');
  console.log('    status / health           Show system status');
  console.log('    morning brief             Daily summary');
  console.log('');
  console.log('  Pipelines:');
  console.log('    review synapse            Full 20-agent Synapse review');
  console.log('');
  console.log('  Anything else:');
  console.log('    "build auth page"         Submitted as a task to the orchestrator');
  console.log('    "what did legal say?"     Routed to the right agent automatically');
  console.log('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Interrupted.\n');
  process.exit(0);
});

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
