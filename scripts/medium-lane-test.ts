/**
 * Deterministic MEDIUM-lane certification helper.
 *
 * Usage: npm run medium-lane-test
 */

import { execFileSync } from 'child_process';

function run(label: string, args: string[]): void {
  console.log(`\n--- ${label} ---`);
  execFileSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
  });
}

async function main(): Promise<void> {
  console.log('\n============================================');
  console.log('Organism MEDIUM Lane Certification');
  console.log('============================================');

  run('Review pipeline', ['node_modules/tsx/dist/cli.mjs', '--test', 'packages/core/src/review-pipeline.test.ts']);
  run('Scheduler', ['node_modules/tsx/dist/cli.mjs', '--test', 'packages/core/src/scheduler.test.ts']);

  console.log('\n✓ MEDIUM LANE CERTIFICATION PASSED');
  console.log('MEDIUM work now waits for Quality Agent and Codex Review before auto-ship.');
}

main().catch((error) => {
  console.error('\n✗ MEDIUM LANE CERTIFICATION FAILED');
  console.error(error);
  process.exit(1);
});
