import { dispatchPendingTasks } from '../packages/core/src/agent-runner.js';
import { getPendingTasks } from '../packages/core/src/task-queue.js';

async function retry() {
  console.log('Dispatching retries...');
  await dispatchPendingTasks();

  let round = 0;
  while (round < 10) {
    round++;
    await new Promise(r => setTimeout(r, 500));
    const pending = getPendingTasks();
    if (pending.length === 0) { console.log('All done.'); break; }
    const agents = [...new Set(pending.map(t => t.agent))].join(', ');
    console.log(`Round ${round}: ${pending.length} pending → [${agents}]`);
    await dispatchPendingTasks();
  }
}
retry().catch(console.error);
