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
import { bootstrapRuntimeEnv } from '../packages/shared/src/runtime-env.js';
bootstrapRuntimeEnv(path.resolve(import.meta.dirname, '..'));
import {
  ensureDB,
  ensureStixDB,
  ensureDaemon,
  ensureDashboard,
  killAll,
  getServiceStatuses,
  isPidAlive,
} from './ensure-services.js';
import { submitPerspectiveReview } from '../packages/core/src/orchestrator.js';
import { writeCombinedReviewToVault } from '../packages/core/src/obsidian-writer.js';

const ROOT = path.resolve(import.meta.dirname, '..');
import { STATE_DIR } from '../packages/shared/src/state-dir.js';

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

  // Execution pipeline
  { patterns: [/^execute$/i, /^work$/i, /^run\s+actions?$/i, /^exec$/i], handler: 'execute' },

  // Agentation sync
  { patterns: [/^sync[-\s]agentation$/i, /^sync\s+feedback$/i], handler: 'sync-agentation' },

  // Onboarding
  { patterns: [/onboard\s+(.+)/i, /onboarding\s+(.+)/i], handler: 'onboard' },

  // Fitness / evolution
  { patterns: [/fitness\s+(\S+)/i, /evolution\s+(\S+)/i], handler: 'fitness' },

  // Knowledge distillation
  { patterns: [/distill\s+(\S+)/i], handler: 'distill' },

  // Palate knowledge system
  { patterns: [/palate\s+add\s+(.+)/i], handler: 'palate-add' },
  { patterns: [/palate\s+approve\s+(\S+)/i], handler: 'palate-approve' },
  { patterns: [/palate\s+list/i], handler: 'palate-list' },
  { patterns: [/palate\s+stats/i], handler: 'palate-stats' },
  { patterns: [/palate\s+remove\s+(\S+)/i], handler: 'palate-remove' },
  { patterns: [/rate\s+(\S+)\s+([1-5])(?:\s+(.+))?/i], handler: 'palate-rate' },

  // Research commands (must precede catch-all)
  { patterns: [/research\s+(\S+)\s+competitors?/i], handler: 'research-competitors' },
  { patterns: [/research\s+(\S+)\s+market/i], handler: 'research-market' },
  { patterns: [/research\s+(\S+)\s+(.+)/i], handler: 'research-topic' },
  { patterns: [/^innovation\s+radar(?:\s+(\S+))?$/i, /^radar(?:\s+(\S+))?$/i], handler: 'innovation-radar' },

  // Perspective review commands (must precede generic review routes)
  { patterns: [/perspectives?\s+(\S+)/i, /perspective\s+review\s+(\S+)/i, /review\s+(\S+)\s+perspectives?/i], handler: 'perspective-review' },

  // Review commands
  { patterns: [/review\s+synapse/i, /synapse\s+review/i], handler: 'review-synapse' },
  { patterns: [/review\s+tokens.?for.?good/i, /tokens.?for.?good\s+review/i, /review\s+tfg/i, /tfg\s+review/i], handler: 'review-tokens-for-good' },

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

async function handleOnboard(projectName: string): Promise<void> {
  const projectId = projectName.toLowerCase().replace(/\s+/g, '-');

  // Check if project already has config
  const configPath = path.join(ROOT, 'knowledge', 'projects', projectId, 'config.json');
  if (fs.existsSync(configPath)) {
    console.log(`\n  Project "${projectId}" already onboarded.`);
    console.log(`  Config: ${configPath}`);
    console.log(`  To re-onboard, delete the config first.\n`);
    return;
  }

  // Try to find project path on Desktop
  const desktopDir = path.resolve(ROOT, '..');
  let projectPath: string | undefined;
  const candidates = [
    path.join(desktopDir, projectName),
    path.join(desktopDir, projectId),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { projectPath = c; break; }
  }

  const { onboardProject } = await import('../packages/core/src/onboarding.js');
  await onboardProject(projectId, projectPath);
}

async function handleResearch(projectId: string, type: string, extra?: string): Promise<void> {
  console.log(`\n  === Research: ${projectId} (${type}) ===\n`);
  await ensureDB();

  const { researchTopic, researchCompetitors, researchMarket } = await import('../packages/core/src/research.js');

  let result;
  if (type === 'competitors') {
    // Try to load competitors from config
    const configPath = path.join(ROOT, 'knowledge', 'projects', projectId, 'config.json');
    let competitors: string[] = [];
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        competitors = config.competitors ?? [];
      } catch { /* ignore */ }
    }
    if (competitors.length === 0 && extra) {
      competitors = extra.split(',').map(s => s.trim());
    }
    result = await researchCompetitors(projectId, competitors, extra);
  } else if (type === 'market') {
    result = await researchMarket(projectId, extra);
  } else {
    result = await researchTopic(projectId, type, extra);
  }

  console.log(`\n  Research saved to:`);
  console.log(`    Knowledge: ${result.filePath}`);
  console.log(`    Vault: ${result.vaultPath}\n`);
}

async function handleFitness(projectId: string): Promise<void> {
  console.log(`\n  === Perspective Fitness: ${projectId} ===\n`);
  await ensureDB();

  const { getProjectFitness } = await import('../packages/core/src/perspectives.js');
  const fitness = getProjectFitness(projectId);

  if (fitness.length === 0) {
    console.log('  No fitness data yet. Run some perspective reviews first.\n');
    return;
  }

  console.log('  Perspective           Fitness  Invocations  Avg Rating  Cost');
  console.log('  ' + '\u2500'.repeat(70));
  for (const f of fitness) {
    const name = f.perspectiveId.padEnd(20);
    const score = f.fitnessScore.toFixed(2).padStart(7);
    const inv = String(f.invocations).padStart(11);
    const rating = f.avgRating.toFixed(1).padStart(10);
    const cost = ('$' + f.totalCostUsd.toFixed(4)).padStart(10);
    console.log(`  ${name} ${score} ${inv} ${rating} ${cost}`);
  }
  console.log('');
}

async function handleDistill(projectId: string): Promise<void> {
  console.log(`\n  === Knowledge Distillation: ${projectId} ===\n`);
  await ensureDB();

  const { distillProject } = await import('../packages/core/src/distillation.js');
  const result = await distillProject(projectId);

  if (result.sourceCount === 0) return;

  console.log(`  Sources: ${result.sourceCount}`);
  console.log(`  Compression: ${(result.inputChars / 1000).toFixed(0)}k → ${(result.outputChars / 1000).toFixed(0)}k chars`);
  console.log(`  Saved: ${result.distilledPath}\n`);
}

async function handlePerspectiveReview(projectName: string): Promise<void> {
  const projectId = projectName.toLowerCase().replace(/\s+/g, '-');
  console.log(`\n  === Perspective Review: ${projectId} ===\n`);

  // Ensure infrastructure
  console.log('  Ensuring services...');
  await ensureDB();
  await ensureStixDB();

  // Load project config if it exists
  let context: Record<string, unknown> = { projectId };
  const configPath = path.join(ROOT, 'knowledge', 'projects', projectId, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      context = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      console.log(`  Loaded project config from ${configPath}`);
    } catch {
      console.log('  Could not parse project config — using minimal context.');
    }
  } else {
    console.log(`  No config found at ${configPath} — using minimal context.`);
  }

  console.log('  Submitting perspective review...\n');
  const startTime = Date.now();
  const result = await submitPerspectiveReview(projectId, 'full', context);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Write results to Obsidian vault
  const writtenPaths = writeCombinedReviewToVault(result);

  // Print summary
  console.log('\n  ── Perspective Review Summary ──\n');
  for (const p of result.perspectives) {
    console.log(`  [${p.perspectiveId}] ${p.domain} — $${p.costUsd.toFixed(4)} (${(p.durationMs / 1000).toFixed(1)}s)`);
  }
  console.log('');
  console.log(`  Total cost:     $${result.totalCostUsd.toFixed(4)}`);
  console.log(`  Total duration: ${elapsed}s`);
  console.log(`  Perspectives:   ${result.perspectives.length}`);
  console.log('');
  console.log('  Vault output:');
  for (const p of writtenPaths) {
    console.log(`    ${p}`);
  }
  console.log('');
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

async function handleReviewTokensForGood(): Promise<void> {
  console.log('\n  === Tokens for Good Full Review ===\n');

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

  const startTime = Date.now();
  await import('./review-tokens-for-good.js');
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Save full output
  try {
    const { getDb } = await import('../packages/core/src/task-queue.js');
    const { getSystemSpend } = await import('../packages/core/src/budget.js');
    const db = getDb();
    const tasks = db.prepare("SELECT * FROM tasks WHERE project_id = 'tokens-for-good' ORDER BY created_at").all() as Array<{
      id: string; agent: string; status: string; description: string; output: string; cost_usd: number;
    }>;

    let report = `Tokens for Good Review — ${new Date().toISOString()}\n`;
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

    const outputPath = path.join(STATE_DIR, 'tfg-review-full.txt');
    fs.writeFileSync(outputPath, report, 'utf8');
    console.log(`\n  Full report saved to ${outputPath}`);
  } catch {
    // Non-critical — review output was already printed to console
  }

  console.log(`\n  Review completed in ${elapsed}s.\n`);
}

async function handleExecute(): Promise<void> {
  const { executeActions } = await import('./execute-actions.js');
  await executeActions();
}

async function handleSyncAgentation(): Promise<void> {
  const enabled = process.env.AGENTATION_ENABLED?.toLowerCase();
  if (enabled !== 'true' && enabled !== '1') {
    console.log('\n  Agentation is not enabled.');
    console.log('  Set AGENTATION_ENABLED=true in your environment to enable it.\n');
    return;
  }

  console.log('\n  Syncing Agentation annotations...\n');

  const { fetchPendingAnnotations } = await import('../packages/core/src/integrations/agentation.js');
  const pending = await fetchPendingAnnotations();

  if (pending.length === 0) {
    console.log('  No pending annotations found.\n');
    return;
  }

  console.log(`  Found ${pending.length} pending annotation(s). Importing...\n`);

  const dashboardUrl = process.env.DASHBOARD_URL?.replace(/\/$/, '') ?? 'http://localhost:3391';
  const dashboardToken = process.env.DASHBOARD_AUTH_TOKEN ?? '';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (dashboardToken) headers['Authorization'] = `Bearer ${dashboardToken}`;

  // Send in batches of 50
  let imported = 0;
  let skipped = 0;
  const batchSize = 50;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize).map(ann => ({
      externalId: ann.id,
      sessionId: ann.sessionId,
      pageUrl: ann.pageUrl,
      kind: ann.kind,
      body: ann.body,
      severity: ann.severity,
      source: 'agentation',
      raw: ann,
    }));

    try {
      const res = await fetch(`${dashboardUrl}/api/feedback/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ annotations: batch }),
      });

      if (res.ok) {
        const result = await res.json() as { imported: number; skipped: number };
        imported += result.imported;
        skipped += result.skipped;
      } else {
        console.log(`  Batch failed: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.log(`  Batch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped (duplicates): ${skipped}`);
  console.log(`  Total processed: ${pending.length}\n`);
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
  await waitForTaskResult(taskId, dispatchPendingTasks, getTask, getSystemSpend);
}

async function handleInnovationRadar(projectName?: string): Promise<void> {
  const projectId = (projectName?.trim().toLowerCase() || 'organism').replace(/\s+/g, '-');
  console.log(`\n  Submitting innovation radar for ${projectId}...\n`);

  await ensureDB();
  await ensureStixDB();

  const { submitTask } = await import('../packages/core/src/orchestrator.js');
  const { loadProjectPolicy } = await import('../packages/core/src/project-policy.js');
  const { dispatchPendingTasks } = await import('../packages/core/src/agent-runner.js');
  const { getTask } = await import('../packages/core/src/task-queue.js');
  const { getSystemSpend } = await import('../packages/core/src/budget.js');
  const policy = loadProjectPolicy(projectId);

  const taskId = await submitTask({
    title: `Innovation radar for ${projectId}`,
    description: policy.innovationRadar.description,
    input: {
      projectId,
      project: projectId,
      triggeredBy: 'cli',
      innovationRadar: true,
      shadowMode: policy.innovationRadar.shadow,
      focusAreas: policy.innovationRadar.focusAreas,
      maxOpportunities: policy.innovationRadar.maxOpportunities,
    },
    projectId,
    workflowKind: 'review',
    sourceKind: 'user',
  }, {
    agent: policy.innovationRadar.agent,
    projectId,
    workflowKind: 'review',
    sourceKind: 'user',
  });

  await waitForTaskResult(taskId, dispatchPendingTasks, getTask, getSystemSpend);
}

async function waitForTaskResult(
  taskId: string,
  dispatchPendingTasks: () => Promise<number>,
  getTask: (taskId: string) => Promise<unknown> | unknown,
  getSystemSpend: () => Promise<number> | number,
): Promise<void> {
  console.log(`  Task created: ${taskId.slice(0, 8)}`);

  const spinner = startSpinner('Processing...');
  const maxRounds = 30;
  let round = 0;

  while (round < maxRounds) {
    round++;
    const task = await getTask(taskId) as {
      status?: string;
      output?: unknown;
      error?: string | null;
      costUsd?: number | null;
    } | null;
    if (!task) break;

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'dead_letter') {
      spinner.stop(`${task.status === 'completed' ? 'Done' : 'Task ' + task.status}`);

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

      const totalSpend = await Promise.resolve(getSystemSpend());
      console.log(`\n  Cost: $${(task.costUsd ?? 0).toFixed(4)} | Total spend: $${totalSpend.toFixed(4)}`);

      try { const { syncToTurso } = await import('../packages/core/src/turso-sync.js'); await syncToTurso(); } catch { /* non-critical */ }
      return;
    }

    spinner.update(`Processing (round ${round}, status: ${task.status})...`);
    await dispatchPendingTasks();
    await sleep(500);
  }

  spinner.stop('Timed out');
  console.log(`\n  Task ${taskId.slice(0, 8)} did not complete in ${maxRounds} rounds.`);
  console.log('  It may still be processing. Run: npm run organism "status"');
  const totalSpend = await Promise.resolve(getSystemSpend());
  console.log(`\n  Spend so far: $${totalSpend.toFixed(4)}\n`);

  try { const { syncToTurso } = await import('../packages/core/src/turso-sync.js'); await syncToTurso(); } catch { /* non-critical */ }
}

// ── Palate handlers ─────────────────────────────────────────────────────────

async function handlePalateAdd(target: string): Promise<void> {
  const { addSource } = await import('../packages/core/src/palate-sources.js');

  // Parse tags from target: "path/to/file.md marketing,growth" or just "path/to/file.md"
  const parts = target.trim().split(/\s+/);
  const pathOrUrl = parts[0];
  const tags = parts.length > 1 ? parts.slice(1).join(',').split(',').map((t) => t.trim()).filter(Boolean) : [];
  const isUrl = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://');

  const source = await addSource({
    url: isUrl ? pathOrUrl : undefined,
    localPath: isUrl ? undefined : pathOrUrl,
    tags,
    scope: 'all',
    addedBy: 'cli',
  });

  console.log(`\n  Source added: ${source.id}`);
  console.log(`  Path: ${source.localPath}`);
  console.log(`  Tags: ${source.tags.length > 0 ? source.tags.join(', ') : '(none — add with: palate add <path> tag1,tag2)'}`);
  console.log(`  Status: UNAPPROVED (run: palate approve ${source.id})\n`);
}

async function handlePalateApprove(id: string): Promise<void> {
  const { approveSource } = await import('../packages/core/src/palate-sources.js');
  const source = approveSource(id);
  console.log(`\n  Approved: ${source.id} (${source.localPath})\n`);
}

async function handlePalateList(): Promise<void> {
  const { listSources } = await import('../packages/core/src/palate-sources.js');
  const sources = listSources();

  if (sources.length === 0) {
    console.log('\n  No sources in the Palate registry.\n');
    return;
  }

  console.log(`\n  Palate Sources (${sources.length}):`);
  console.log('  ' + '─'.repeat(70));
  for (const s of sources) {
    const status = s.approved ? '\x1b[32mAPPROVED\x1b[0m' : '\x1b[33mPENDING\x1b[0m';
    const fitness = s.fitness.toFixed(2);
    const tags = s.tags.length > 0 ? s.tags.join(', ') : '(no tags)';
    console.log(`  ${s.id.padEnd(25)} ${status.padEnd(20)} fitness: ${fitness}  tags: ${tags}`);
    console.log(`    ${s.localPath}`);
  }
  console.log('');
}

async function handlePalateStats(): Promise<void> {
  const { getInjectionStats } = await import('../packages/core/src/palate-sources.js');
  const stats = getInjectionStats();

  console.log('\n  Palate Injection Stats:');
  console.log('  ' + '─'.repeat(50));
  console.log(`  Total injections:    ${stats.totalInjections}`);
  console.log(`  Raw tokens:          ${stats.totalRawTokens.toLocaleString()}`);
  console.log(`  Distilled tokens:    ${stats.totalDistilledTokens.toLocaleString()}`);
  console.log(`  Token savings:       ${stats.totalSavings.toLocaleString()}`);
  if (Object.keys(stats.byCapability).length > 0) {
    console.log('\n  By Capability:');
    for (const [cap, count] of Object.entries(stats.byCapability)) {
      console.log(`    ${cap.padEnd(35)} ${count}x`);
    }
  }
  console.log('');
}

async function handlePalateRemove(id: string): Promise<void> {
  const { removeSource } = await import('../packages/core/src/palate-sources.js');
  removeSource(id);
  console.log(`\n  Removed source: ${id}\n`);
}

async function handlePalateRate(page: string, rating: number, notes?: string): Promise<void> {
  const { rateWikiPage } = await import('../packages/core/src/palate-ratings.js');
  rateWikiPage(page, rating, notes);
  console.log(`\n  Rated ${page}: ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}${notes ? ` — ${notes}` : ''}\n`);
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
      case 'execute':       await handleExecute(); break;
      case 'sync-agentation': await handleSyncAgentation(); break;
      case 'onboard': {
        const projectName = matchRoute(input).match[1] ?? input.split(/\s+/).pop() ?? '';
        await handleOnboard(projectName);
        break;
      }
      case 'fitness': {
        const project = matchRoute(input).match[1] ?? 'organism';
        await handleFitness(project);
        break;
      }
      case 'distill': {
        const project = matchRoute(input).match[1] ?? 'organism';
        await handleDistill(project);
        break;
      }
      case 'perspective-review': {
        const projectName = matchRoute(input).match[1] ?? input.split(/\s+/).pop() ?? 'organism';
        await handlePerspectiveReview(projectName);
        break;
      }
      case 'research-competitors': {
        const project = matchRoute(input).match[1] ?? '';
        await handleResearch(project, 'competitors');
        break;
      }
      case 'research-market': {
        const project = matchRoute(input).match[1] ?? '';
        await handleResearch(project, 'market');
        break;
      }
      case 'research-topic': {
        const m = matchRoute(input).match;
        await handleResearch(m[1] ?? '', m[2] ?? 'general');
        break;
      }
      case 'innovation-radar': {
        await handleInnovationRadar(matchRoute(input).match[1] ?? 'organism');
        break;
      }
      case 'review-synapse': await handleReviewSynapse(); break;
      case 'review-tokens-for-good': await handleReviewTokensForGood(); break;
      case 'palate-add': {
        const target = matchRoute(input).match[1] ?? '';
        await handlePalateAdd(target);
        break;
      }
      case 'palate-approve': {
        const id = matchRoute(input).match[1] ?? '';
        await handlePalateApprove(id);
        break;
      }
      case 'palate-list': await handlePalateList(); break;
      case 'palate-stats': await handlePalateStats(); break;
      case 'palate-remove': {
        const id = matchRoute(input).match[1] ?? '';
        await handlePalateRemove(id);
        break;
      }
      case 'palate-rate': {
        const m = matchRoute(input).match;
        await handlePalateRate(m[1] ?? '', parseInt(m[2] ?? '3', 10), m[3]);
        break;
      }
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
  console.log('    execute / work            Run approved action items from dashboard');
  console.log('');
  console.log('  Projects:');
  console.log('    onboard <project>            Interview → VISION.md + config.json');
  console.log('');
  console.log('  Research:');
  console.log('    research <project> competitors  Competitor analysis → vault');
  console.log('    research <project> market       Market landscape → vault');
  console.log('    research <project> <topic>      Custom research → vault');
  console.log('    innovation radar [project]      Run the shadow innovation radar for a project');
  console.log('');
  console.log('  Evolution:');
  console.log('    fitness <project>             Show Darwinian perspective fitness scores');
  console.log('');
  console.log('  Feedback:');
  console.log('    sync-agentation               Import pending Agentation annotations');
  console.log('    sync feedback                 Alias for sync-agentation');
  console.log('');
  console.log('  Knowledge:');
  console.log('    distill <project>             Condense all reviews into knowledge summary');
  console.log('');
  console.log('  Palate (knowledge sources):');
  console.log('    palate list                   Show all registered sources + fitness');
  console.log('    palate stats                  Injection telemetry (tokens, savings, cache)');
  console.log('    palate add <path> [tags]       Register local file (e.g. palate add doc.md marketing,growth)');
  console.log('    palate add <url> [tags]        Fetch + register URL (unapproved by default)');
  console.log('    palate approve <id>            Approve source for injection');
  console.log('    palate remove <id>             Remove source from registry');
  console.log('    rate <page> <1-5> [notes]      Rate a wiki page (feeds Darwinian fitness)');
  console.log('');
  console.log('  Pipelines:');
  console.log('    review synapse            Full 20-agent Synapse review');
  console.log('    review tokens-for-good    Full 20-agent TfG review');
  console.log('    perspectives synapse      Perspective-based review → Obsidian vault');
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
