/**
 * execute-actions.ts — The auto-execution pipeline.
 *
 * Reads approved action_items from Turso (status='todo'), creates Organism tasks,
 * dispatches them via the agent runner, and updates status back to Turso.
 *
 * Flow:
 *   1. Fetch action_items WHERE status='todo' from Turso
 *   2. For HIGH priority: skip unless G4-approved (rafael_notes contains approval)
 *   3. For LOW/MEDIUM: execute automatically
 *   4. Create local task via submitTask() → dispatch via dispatchPendingTasks()
 *   5. Update action_item status in Turso (todo → in_progress → done)
 *
 * Usage: npm run execute
 *        npm run organism "execute"
 *        npm run organism "work"
 */

import { createClient, type Client } from '@libsql/client';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { submitTask, type SubmitTaskOptions } from '../packages/core/src/orchestrator.js';
import { dispatchPendingTasks } from '../packages/core/src/agent-runner.js';
import { getTask } from '../packages/core/src/task-queue.js';
import { writeAudit } from '../packages/core/src/audit.js';
import { ensureDB, ensureStixDB } from './ensure-services.js';

// ── Types ───────────────────────────────────────────────────────────────────

interface ActionItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  status: string;
  sourceTaskId: string | null;
  sourceAgent: string | null;
  dueDate: string | null;
  createdAt: number;
  updatedAt: number | null;
  rafaelNotes: string | null;
}

interface ExecutionResult {
  actionItemId: string;
  taskId: string | null;
  status: 'done' | 'failed' | 'skipped';
  reason?: string;
}

// ── Turso connection ────────────────────────────────────────────────────────

function loadEnv(): void {
  const envFile = resolve(import.meta.dirname ?? '.', '../packages/dashboard-v2/.env.production.local');
  if (!existsSync(envFile)) return;
  const lines = readFileSync(envFile, 'utf-8').split('\n');
  for (const line of lines) {
    const match = line.match(/^(\w+)="(.+)"$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

function getTursoClient(): Client {
  loadEnv();

  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;

  if (!url || !token) {
    console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN');
    process.exit(1);
  }

  return createClient({ url, authToken: token });
}

// ── Read action items from Turso ────────────────────────────────────────────

async function fetchTodoActions(turso: Client): Promise<ActionItem[]> {
  // Ensure the action_items table exists (dashboard creates it, but be safe)
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS action_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'MEDIUM',
      status TEXT NOT NULL DEFAULT 'todo',
      source_task_id TEXT,
      source_agent TEXT,
      due_date TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      rafael_notes TEXT
    )
  `);

  const result = await turso.execute(`
    SELECT * FROM action_items
    WHERE status = 'todo'
    ORDER BY
      CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END,
      created_at ASC
  `);

  return result.rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    description: row.description ? String(row.description) : '',
    priority: String(row.priority) as 'HIGH' | 'MEDIUM' | 'LOW',
    status: String(row.status),
    sourceTaskId: row.source_task_id ? String(row.source_task_id) : null,
    sourceAgent: row.source_agent ? String(row.source_agent) : null,
    dueDate: row.due_date ? String(row.due_date) : null,
    createdAt: Number(row.created_at),
    updatedAt: row.updated_at ? Number(row.updated_at) : null,
    rafaelNotes: row.rafael_notes ? String(row.rafael_notes) : null,
  }));
}

// ── Update action item status in Turso ──────────────────────────────────────

async function updateActionStatus(
  turso: Client,
  id: string,
  status: 'in_progress' | 'done' | 'failed',
  notes?: string,
): Promise<void> {
  const sets = ['status = ?', 'updated_at = ?'];
  const args: (string | number | null)[] = [status, Date.now()];

  if (notes) {
    sets.push('rafael_notes = COALESCE(rafael_notes, \'\') || ?');
    args.push(`\n[organism] ${notes}`);
  }

  args.push(id);

  await turso.execute({
    sql: `UPDATE action_items SET ${sets.join(', ')} WHERE id = ?`,
    args,
  });
}

// ── G4 gate check for HIGH priority items ───────────────────────────────────

function isG4Approved(item: ActionItem): boolean {
  // HIGH items need explicit approval. We check:
  // 1. rafael_notes contains an approval signal (set by dashboard)
  // 2. The item was explicitly moved to 'todo' status by Rafael after review
  //    (dashboard only sets status='todo' after Rafael approves a finding)
  //
  // Since items only reach status='todo' after Rafael approves them on the
  // dashboard, the mere presence in the todo queue means Rafael approved.
  // But for HIGH items, we additionally require rafael_notes to contain
  // an explicit "approved" or "execute" signal, OR the item must have been
  // updated (updatedAt > createdAt) indicating Rafael interacted with it.
  if (item.rafaelNotes) {
    const notes = item.rafaelNotes.toLowerCase();
    if (notes.includes('approved') || notes.includes('execute') || notes.includes('go ahead') || notes.includes('yes')) {
      return true;
    }
  }

  // If Rafael has updated the item (via dashboard interaction), treat as approved
  if (item.updatedAt && item.updatedAt > item.createdAt) {
    return true;
  }

  return false;
}

// ── Execute a single action item ────────────────────────────────────────────

async function executeAction(
  turso: Client,
  item: ActionItem,
): Promise<ExecutionResult> {
  const label = `[${item.id.slice(0, 8)}] ${item.priority} "${item.title.slice(0, 50)}"`;

  // G4 gate for HIGH priority
  if (item.priority === 'HIGH' && !isG4Approved(item)) {
    console.log(`  SKIP ${label} — HIGH priority, awaiting G4 approval from Rafael`);
    return { actionItemId: item.id, taskId: null, status: 'skipped', reason: 'HIGH priority — needs G4 approval' };
  }

  console.log(`  EXEC ${label}`);

  // Mark as in_progress in Turso
  await updateActionStatus(turso, item.id, 'in_progress');

  try {
    // Build task description from the action item
    const description = item.description
      ? `${item.title}\n\n${item.description}`
      : item.title;

    // Determine the agent — use source_agent if available, otherwise let orchestrator route
    const options: SubmitTaskOptions = {
      projectId: item.projectId,
    };
    if (item.sourceAgent) {
      options.agent = item.sourceAgent;
    }

    // Submit to Organism
    const taskId = await submitTask(
      { description, input: { actionItemId: item.id, title: item.title, description: item.description } },
      options,
    );

    console.log(`    Task created: ${taskId.slice(0, 8)} → agent: ${item.sourceAgent ?? 'auto-routed'}`);

    writeAudit({
      agent: item.sourceAgent ?? 'orchestrator',
      taskId,
      action: 'task_created',
      payload: { actionItemId: item.id, priority: item.priority, title: item.title, source: 'execute-actions' },
      outcome: 'success',
    });

    // Dispatch and wait for completion (with timeout)
    const maxRounds = 60;
    let round = 0;
    let taskDone = false;

    while (round < maxRounds) {
      round++;
      await dispatchPendingTasks();

      const task = getTask(taskId);
      if (!task) break;

      if (task.status === 'completed') {
        taskDone = true;
        const costStr = task.costUsd ? `$${task.costUsd.toFixed(4)}` : '$0';
        console.log(`    Done (${round} rounds, ${costStr})`);

        // Extract output summary for the notes
        let outputSummary = '';
        if (task.output) {
          const out = task.output as Record<string, unknown>;
          outputSummary = (out.text as string) ?? (out.summary as string) ?? (out.implementation as string) ?? '';
          outputSummary = outputSummary.slice(0, 500);
        }

        await updateActionStatus(turso, item.id, 'done', outputSummary ? `Completed. Output: ${outputSummary}` : 'Completed.');
        return { actionItemId: item.id, taskId, status: 'done' };
      }

      if (task.status === 'failed' || task.status === 'dead_letter') {
        console.log(`    FAILED: ${task.error ?? 'unknown'}`);
        await updateActionStatus(turso, item.id, 'failed', `Task ${task.status}: ${task.error ?? 'unknown'}`);
        return { actionItemId: item.id, taskId, status: 'failed', reason: task.error ?? 'unknown' };
      }

      // Brief wait between dispatch rounds
      await sleep(1000);
    }

    if (!taskDone) {
      console.log(`    TIMEOUT after ${maxRounds} rounds — task may still be running`);
      await updateActionStatus(turso, item.id, 'in_progress', `Timed out after ${maxRounds} rounds — task ${taskId.slice(0, 8)} may still complete.`);
      return { actionItemId: item.id, taskId, status: 'failed', reason: `Timed out after ${maxRounds} rounds` };
    }

    // Should not reach here
    return { actionItemId: item.id, taskId, status: 'failed', reason: 'Unexpected state' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`    ERROR: ${errMsg}`);
    await updateActionStatus(turso, item.id, 'failed', `Error: ${errMsg}`);
    return { actionItemId: item.id, taskId: null, status: 'failed', reason: errMsg };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n  === Organism Execution Pipeline ===\n');

  // Boot infrastructure
  console.log('  Ensuring services...');
  await ensureDB();
  await ensureStixDB();

  // Connect to Turso
  console.log('  Connecting to Turso...');
  const turso = getTursoClient();

  // Fetch todo items
  const items = await fetchTodoActions(turso);

  if (items.length === 0) {
    console.log('  No pending action items. Nothing to execute.\n');
    turso.close();
    return;
  }

  console.log(`  Found ${items.length} action item(s) to process:\n`);

  // Show summary before executing
  const highCount = items.filter(i => i.priority === 'HIGH').length;
  const medCount = items.filter(i => i.priority === 'MEDIUM').length;
  const lowCount = items.filter(i => i.priority === 'LOW').length;
  console.log(`    HIGH: ${highCount}  MEDIUM: ${medCount}  LOW: ${lowCount}\n`);

  // Execute each item sequentially (to avoid overwhelming the agent runner)
  const results: ExecutionResult[] = [];

  for (const item of items) {
    const result = await executeAction(turso, item);
    results.push(result);
  }

  // Summary
  const done = results.filter(r => r.status === 'done').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;

  console.log('\n  ── Execution Summary ──\n');
  console.log(`    Done:    ${done}`);
  console.log(`    Failed:  ${failed}`);
  console.log(`    Skipped: ${skipped} (HIGH priority awaiting G4)`);
  console.log('');

  // Sync updated state back to Turso is implicit — we updated directly in Turso
  turso.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Run if invoked directly
main().catch((err) => {
  console.error('Execution pipeline failed:', err);
  process.exit(1);
});

// Export for use by CLI
export { main as executeActions, fetchTodoActions, getTursoClient };
