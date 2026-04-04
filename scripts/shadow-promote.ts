/**
 * Promotes an agent from shadow → active status in the capability registry.
 *
 * Usage: tsx scripts/shadow-promote.ts <agent-name>
 *
 * Requirements before promotion:
 * - Agent has ≥ 10 shadow runs in state/shadow-runs table
 * - Average quality score ≥ 0.7
 */

import { getDb } from '../packages/core/src/task-queue.js';
import { updateAgentStatus } from '../packages/core/src/registry.js';

const agentName = process.argv[2];
const forceFlag = process.argv.includes('--force');
if (!agentName) {
  console.error('Usage: tsx scripts/shadow-promote.ts <agent-name> [--force]');
  console.error('  --force: skip shadow run requirements (development only)');
  process.exit(1);
}

async function promoteAgent() {
  const db = getDb();

  // Check shadow run history
  const stats = db.prepare(`
    SELECT
      COUNT(*) as run_count,
      AVG(quality_score) as avg_score,
      MIN(quality_score) as min_score
    FROM shadow_runs
    WHERE agent = ?
  `).get(agentName) as { run_count: number; avg_score: number; min_score: number } | undefined;

  console.log(`\nShadow run stats for '${agentName}':`);
  console.log(`  Runs: ${stats?.run_count ?? 0}`);
  console.log(`  Avg quality score: ${stats?.avg_score?.toFixed(2) ?? 'N/A'}`);
  console.log(`  Min quality score: ${stats?.min_score?.toFixed(2) ?? 'N/A'}`);

  if (forceFlag) {
    console.log('\n⚠  --force flag set: skipping shadow run requirements (development mode)');
  } else {
    if (!stats || stats.run_count === 0) {
      console.error(`No shadow runs found for '${agentName}'. Run it in shadow mode first, or use --force for dev.`);
      process.exit(1);
    }
    if (stats.run_count < 10) {
      console.error(`\nFAIL: Need ≥ 10 shadow runs, only have ${stats.run_count}. Use --force for dev. Code: E303`);
      process.exit(1);
    }
    if (stats.avg_score !== null && stats.avg_score < 0.7) {
      console.error(`\nFAIL: Avg quality score ${stats.avg_score.toFixed(2)} < 0.7. Use --force for dev. Code: E303`);
      process.exit(1);
    }
  }

  // Promote
  updateAgentStatus(agentName, 'active');
  console.log(`\n✓ Agent '${agentName}' promoted to active status.`);
  console.log(`  Update capability-registry.json has been updated.`);
}

promoteAgent().catch((err) => {
  console.error('Promotion failed:', err);
  process.exit(1);
});
