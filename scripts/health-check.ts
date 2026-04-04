/**
 * Pre-flight health check — run before starting any agents.
 * Verifies all required secrets, state directory, and database.
 */

import * as fs from 'fs';
import * as path from 'path';
import { requireSecrets } from '../packages/shared/src/secrets.js';
import { getDb } from '../packages/core/src/task-queue.js';

const REQUIRED_SECRETS = ['ANTHROPIC_API_KEY'];

async function healthCheck() {
  let allOk = true;

  console.log('\n=== Organism Health Check ===\n');

  // 1. Secrets
  process.stdout.write('Secrets: ');
  try {
    requireSecrets(REQUIRED_SECRETS);
    console.log('OK');
  } catch (err) {
    console.log(`FAIL — ${err}`);
    allOk = false;
  }

  // 2. State directory
  process.stdout.write('State directory: ');
  const stateDir = path.resolve(process.cwd(), 'state');
  if (fs.existsSync(stateDir)) {
    console.log('OK');
  } else {
    fs.mkdirSync(stateDir, { recursive: true });
    console.log('Created');
  }

  // 3. Database
  process.stdout.write('Database (tasks.db): ');
  try {
    const db = getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    console.log(row ? 'OK' : 'FAIL — tasks table missing');
    if (!row) allOk = false;
  } catch (err) {
    console.log(`FAIL — ${err}`);
    allOk = false;
  }

  // 4. Capability registry
  process.stdout.write('Capability registry: ');
  const registryPath = path.resolve(process.cwd(), 'knowledge/capability-registry.json');
  if (fs.existsSync(registryPath)) {
    try {
      const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const activeCount = reg.capabilities.filter((c: { status: string }) => c.status === 'active').length;
      console.log(`OK (${activeCount} active agents)`);
    } catch {
      console.log('FAIL — invalid JSON');
      allOk = false;
    }
  } else {
    console.log('FAIL — file not found');
    allOk = false;
  }

  // 5. CLAUDE.md
  process.stdout.write('Root CLAUDE.md: ');
  const claudeMdPath = path.resolve(process.cwd(), 'CLAUDE.md');
  console.log(fs.existsSync(claudeMdPath) ? 'OK' : 'MISSING (non-fatal)');

  // 6. OpenAI key (optional but needed for Codex Review)
  process.stdout.write('OpenAI API key (optional): ');
  const openaiKey = process.env.OPENAI_API_KEY;
  console.log(openaiKey ? 'Present' : 'Missing — Codex Review will not function');

  console.log(`\n${allOk ? '✓ All checks passed. Safe to start agents.' : '✗ Fix the issues above before running agents.'}\n`);

  if (!allOk) process.exit(1);
}

healthCheck().catch((err) => {
  console.error('Health check crashed:', err);
  process.exit(1);
});
