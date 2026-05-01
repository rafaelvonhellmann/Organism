/**
 * Organism certification gate.
 *
 * This replaces the old live-LLM smoke test with the deterministic release
 * gate for the current control plane:
 * - review pipeline enforcement
 * - stale/recovery handling
 * - audit ledger truth
 * - registry coherence
 * - sidecar boundary invariants
 * - scheduler behavior
 * - type safety
 * - public health check
 *
 * Usage: npm run smoke-test
 */

import { execFileSync } from 'child_process';

interface Check {
  label: string;
  command: string;
  args: string[];
}

const checks: Check[] = [
  {
    label: 'Review pipeline',
    command: process.execPath,
    args: ['node_modules/tsx/dist/cli.mjs', '--test', 'packages/core/src/review-pipeline.test.ts'],
  },
  {
    label: 'Scheduler',
    command: process.execPath,
    args: ['node_modules/tsx/dist/cli.mjs', '--test', 'packages/core/src/scheduler.test.ts'],
  },
  {
    label: 'Recovery',
    command: process.execPath,
    args: ['node_modules/tsx/dist/cli.mjs', '--test', 'packages/core/src/run-recovery.test.ts'],
  },
  {
    label: 'Daemon startup',
    command: process.execPath,
    args: ['node_modules/tsx/dist/cli.mjs', '--test', 'packages/core/src/daemon-startup.test.ts'],
  },
  {
    label: 'Audit ledger',
    command: process.execPath,
    args: ['node_modules/tsx/dist/cli.mjs', '--test', 'packages/core/src/audit.test.ts'],
  },
  {
    label: 'Registry coherence',
    command: process.execPath,
    args: ['node_modules/tsx/dist/cli.mjs', '--test', 'packages/core/src/registry.test.ts'],
  },
  {
    label: 'Sidecar boundary',
    command: process.execPath,
    args: ['node_modules/tsx/dist/cli.mjs', '--test', 'packages/core/src/sidecar-boundary.test.ts'],
  },
  {
    label: 'Shadow scoring',
    command: process.execPath,
    args: ['node_modules/tsx/dist/cli.mjs', '--test', 'packages/core/src/shadow-quality.test.ts'],
  },
  {
    label: 'TypeScript',
    command: process.execPath,
    args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'],
  },
  {
    label: 'Public health check',
    command: process.execPath,
    args: ['node_modules/tsx/dist/cli.mjs', '--experimental-sqlite', 'scripts/health-check.ts'],
  },
];

function runCheck(check: Check): void {
  console.log(`\n--- ${check.label} ---`);
  execFileSync(check.command, check.args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
  });
}

async function main(): Promise<void> {
  console.log('\n========================================');
  console.log('Organism Certification Gate');
  console.log('========================================');

  for (const check of checks) {
    runCheck(check);
  }

  console.log('\n✓ CERTIFICATION PASSED');
  console.log('Organism control-plane, sidecar boundary, and public startup path are all green.');
}

main().catch((error) => {
  console.error('\n✗ CERTIFICATION FAILED');
  console.error(error);
  process.exit(1);
});
