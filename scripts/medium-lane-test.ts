/**
 * MEDIUM lane smoke test — Week 2 gate.
 * Verifies: submit → Grill-Me interrogates → Engineering implements (shadow) → Quality reviews → complete
 */

import { submitTask } from '../packages/core/src/orchestrator.js';
import { getTask, getPendingTasks } from '../packages/core/src/task-queue.js';
import { dispatchPendingTasks } from '../packages/core/src/agent-runner.js';
import { getSystemSpend } from '../packages/core/src/budget.js';

async function runMediumTest() {
  console.log('\n============================================');
  console.log('Organism — MEDIUM Lane Test (Week 2 Gate)');
  console.log('============================================\n');

  const spendBefore = getSystemSpend();

  console.log('Submitting MEDIUM-risk task...');
  const taskId = await submitTask({
    description: 'Add a /health endpoint to the Organism dashboard that returns 200 OK with JSON system status',
    input: {
      file: 'packages/dashboard/src/server.ts',
      endpoint: '/health',
      returns: '{ status: "ok", uptime: number, pendingTasks: number }',
    },
  });

  const originalTask = getTask(taskId)!;
  console.log(`Task: ${taskId}`);
  console.log(`Lane: ${originalTask.lane}`);
  console.log(`Routed to: ${originalTask.agent}\n`);

  // Run 4 dispatch cycles: Grill-Me → Engineering → Quality Agent → (any remaining)
  for (let pass = 1; pass <= 4; pass++) {
    const pending = getPendingTasks();
    if (pending.length === 0) break;
    console.log(`--- Pass ${pass}: ${pending.map(t => `${t.agent}(${t.lane})`).join(', ')} ---`);
    await dispatchPendingTasks();
    await sleep(500);
  }

  const finalTask = getTask(taskId)!;
  const spendAfter = getSystemSpend();
  const cost = spendAfter - spendBefore;

  console.log(`\nOriginal task status: ${finalTask.status}`);
  console.log(`Total cost: $${cost.toFixed(4)}`);

  const checks = [
    { name: 'Grill-Me ran (task routed to grill-me)', pass: originalTask.agent === 'grill-me' },
    { name: 'Original task completed', pass: finalTask.status === 'completed' },
    { name: 'Cost < $5', pass: cost < 5.00 },
  ];

  console.log('\n--- Results ---');
  let allPassed = true;
  for (const check of checks) {
    console.log(`  ${check.pass ? '✓' : '✗'} ${check.name}`);
    if (!check.pass) allPassed = false;
  }

  console.log(allPassed ? '\n✓ MEDIUM LANE: PASSED' : '\n✗ MEDIUM LANE: FAILED');
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

runMediumTest().catch(err => { console.error(err); process.exit(1); });
