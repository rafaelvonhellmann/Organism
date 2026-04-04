/**
 * Smoke test — the hard gate for Week 1.
 *
 * Submits a test task and verifies the full LOW-risk pipeline:
 *   submitted → risk-classified → CEO processes → quality reviewed → completed
 *
 * Must pass before Week 1 is declared done.
 * Total cost must be < $2.
 *
 * Usage: npm run smoke-test
 * Requires: ANTHROPIC_API_KEY in .secrets.json or environment
 */

import { submitTask } from '../packages/core/src/orchestrator.js';
import { getTask } from '../packages/core/src/task-queue.js';
import { getSystemSpend } from '../packages/core/src/budget.js';
import { readRecentForTask } from '../packages/core/src/audit.js';
import { dispatchPendingTasks } from '../packages/core/src/agent-runner.js';

async function runSmokeTest() {
  console.log('\n========================================');
  console.log('Organism Smoke Test — Week 1 Gate');
  console.log('========================================\n');

  const spendBefore = getSystemSpend();

  // Submit the canonical smoke test task
  console.log('Submitting test task...');
  const taskId = await submitTask({
    description: 'Write a one-paragraph mission statement for Organism — the autonomous company orchestration system.',
    input: {
      context: 'Organism runs specialized AI agents across multiple organizational layers. Rafael is the board member who reviews at G4 gates.',
      format: 'One paragraph, professional tone, under 100 words.',
    },
  });

  console.log(`Task created: ${taskId}\n`);

  // Run the dispatch loop until the original task (and its quality review) complete
  const start = Date.now();
  const TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

  while (Date.now() - start < TIMEOUT_MS) {
    const task = getTask(taskId)!;

    if (task.status === 'completed' || task.status === 'failed') {
      // Give quality review one more dispatch cycle if CEO just completed
      if (task.status === 'completed') {
        console.log('CEO task complete. Running quality review pass...');
        await dispatchPendingTasks();
      }
      break;
    }

    console.log(`[${Math.floor((Date.now() - start) / 1000)}s] Status: ${task.status} — dispatching...`);
    await dispatchPendingTasks();
    await sleep(1000);
  }

  const task = getTask(taskId)!;
  console.log(`\nFinal status: ${task.status}`);

  // Audit trail
  const auditEntries = readRecentForTask(taskId);
  console.log(`\nAudit trail (${auditEntries.length} entries):`);
  for (const entry of auditEntries) {
    const ts = new Date(entry.ts).toISOString();
    console.log(`  [${ts}] ${entry.action} → ${entry.outcome}${entry.errorCode ? ` (${entry.errorCode})` : ''}`);
  }

  // Cost
  const spendAfter = getSystemSpend();
  const smokeCost = spendAfter - spendBefore;
  console.log(`\nSmoke test cost: $${smokeCost.toFixed(4)}`);

  // Gate checks
  const checks = [
    { name: 'Task completed', pass: task.status === 'completed' },
    { name: 'Audit trail exists (≥3 entries)', pass: auditEntries.length >= 3 },
    { name: 'Cost < $2', pass: smokeCost < 2.00 },
    { name: 'Output exists', pass: task.output !== undefined },
  ];

  console.log('\n--- Smoke Test Results ---');
  let allPassed = true;
  for (const check of checks) {
    const icon = check.pass ? '✓' : '✗';
    console.log(`  ${icon} ${check.name}`);
    if (!check.pass) allPassed = false;
  }

  if (allPassed) {
    console.log('\n✓ WEEK 1 GATE: PASSED');
    console.log('\nNext: add a lessons.md entry and declare Week 1 done.');
  } else {
    console.log('\n✗ WEEK 1 GATE: FAILED');
    console.log('Fix the issues above before declaring Week 1 done.');
    process.exit(1);
  }

  // Print the mission statement
  if (task.output) {
    const out = task.output as Record<string, unknown>;
    console.log('\n--- Mission Statement ---');
    console.log((out.text as string) ?? JSON.stringify(task.output, null, 2));
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

runSmokeTest().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
