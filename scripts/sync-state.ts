import { bootstrapRuntimeEnv } from '../packages/shared/src/runtime-env.js';
import { syncToTurso } from '../packages/core/src/turso-sync.js';

bootstrapRuntimeEnv();

async function main(): Promise<void> {
  const result = await syncToTurso();
  console.log(JSON.stringify({
    status: result.status,
    reason: result.reason ?? null,
  }));
}

main().catch((err) => {
  console.error('[sync-state] failed:', err);
  process.exit(1);
});
