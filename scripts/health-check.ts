/**
 * Pre-flight health check — run before starting any agents.
 * Verifies the selected runtime backends, state directory, and database.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveCodeExecutor } from '../packages/core/src/code-executor.js';
import { probeSidecarStatus, resolveModelBackend, SIDECAR_TOOL_NAMES } from '../agents/_base/mcp-client.js';
import { listProjectPolicies } from '../packages/core/src/project-policy.js';
import { getProjectLaunchReadiness } from '../packages/core/src/project-readiness.js';
import { getDb } from '../packages/core/src/task-queue.js';
import { checkRegistryCoherence } from '../packages/core/src/registry.js';
import { getRegisteredAgentNames } from '../packages/core/src/agent-runner.js';
import { STATE_DIR } from '../packages/shared/src/state-dir.js';
import { bootstrapRuntimeEnv } from '../packages/shared/src/runtime-env.js';
import { getSecretOrNull } from '../packages/shared/src/secrets.js';
import { getProjectLaunchAudit } from '../packages/core/src/launch-audit.js';

bootstrapRuntimeEnv();

async function healthCheck() {
  let allOk = true;

  console.log('\n=== Organism Health Check ===\n');

  // 1. Model backend
  process.stdout.write('Model backend: ');
  try {
    const backend = resolveModelBackend();
    console.log(
      `${backend.selected} (preferred=${backend.preferred}, claudeCli=${backend.available.claudeCli}, anthropicApi=${backend.available.anthropicApi}, codexCli=${backend.available.codexCli}, openaiApi=${backend.available.openaiApi}, webSearch=${backend.capabilities.webSearch})`,
    );
  } catch (err) {
    console.log(`FAIL — ${err}`);
    allOk = false;
  }

  // 2. PraisonAI sidecar boundary
  process.stdout.write('PraisonAI sidecar: ');
  try {
    const sidecar = await probeSidecarStatus();
    const toolCountOk = SIDECAR_TOOL_NAMES.length === 5;
    const selected = sidecar.selected;
    const detail = `${selected} (${SIDECAR_TOOL_NAMES.length} tools${sidecar.fallbackReason ? `, fallback=${sidecar.fallbackReason}` : ''})`;
    if (!toolCountOk || selected === 'disabled') {
      console.log(`FAIL — ${detail}`);
      allOk = false;
    } else {
      console.log(`OK — ${detail}`);
    }
  } catch (err) {
    console.log(`FAIL — ${err}`);
    allOk = false;
  }

  // 3. State directory
  process.stdout.write('State directory: ');
  if (fs.existsSync(STATE_DIR)) {
    console.log('OK');
  } else {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    console.log('Created');
  }

  // 4. Database
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

  // 5. Capability registry
  process.stdout.write('Capability registry: ');
  const registryPath = path.resolve(process.cwd(), 'knowledge/capability-registry.json');
  if (fs.existsSync(registryPath)) {
    try {
      const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const activeCount = reg.capabilities.filter((c: { status: string }) => c.status === 'active').length;
      const coherence = checkRegistryCoherence(getRegisteredAgentNames());
      if (coherence.missingImplementations.length > 0 || coherence.orphanedImplementations.length > 0) {
        console.log(
          `FAIL — registry drift (missing: ${coherence.missingImplementations.join(', ') || 'none'}; orphaned: ${coherence.orphanedImplementations.join(', ') || 'none'})`,
        );
        allOk = false;
      } else {
        console.log(`OK (${activeCount} active agents)`);
      }
    } catch {
      console.log('FAIL — invalid JSON');
      allOk = false;
    }
  } else {
    console.log('FAIL — file not found');
    allOk = false;
  }

  // 6. CLAUDE.md
  process.stdout.write('Root CLAUDE.md: ');
  const claudeMdPath = path.resolve(process.cwd(), 'CLAUDE.md');
  console.log(fs.existsSync(claudeMdPath) ? 'OK' : 'MISSING (non-fatal)');

  // 7. OpenAI key (optional if Codex CLI is available, but required for API fallback)
  process.stdout.write('OpenAI API key: ');
  const openaiKey = getSecretOrNull('OPENAI_API_KEY');
  console.log(openaiKey ? 'Present' : 'Missing — Codex CLI remains primary, API fallback disabled');

  // 8. Anthropic API key (legacy optional only)
  process.stdout.write('Anthropic API key (legacy optional): ');
  console.log(getSecretOrNull('ANTHROPIC_API_KEY') ? 'Present — legacy fallback available' : 'Missing — legacy fallback disabled');

  // 9. Code executor availability
  process.stdout.write('Code executor: ');
  try {
    const executor = resolveCodeExecutor();
    console.log(`${executor.selected} (preferred=${executor.preferred}, claude=${executor.available.claude}, codex=${executor.available.codex})`);
  } catch (err) {
    console.log(`FAIL — ${err}`);
    allOk = false;
  }

  // 10. Project launch readiness
  process.stdout.write('Dashboard auth: ');
  const dashboardAuthReady = Boolean(process.env.DASHBOARD_AUTH_TOKEN?.trim());
  const dashboardAuthRequired = process.env.NODE_ENV === 'production'
    || process.env.VERCEL === '1'
    || /^(1|true|yes)$/i.test(process.env.DASHBOARD_REQUIRE_AUTH ?? '');
  if (dashboardAuthReady) {
    console.log('OK');
  } else if (dashboardAuthRequired) {
    console.log('FAIL — DASHBOARD_AUTH_TOKEN is required for production dashboard command access');
    allOk = false;
  } else {
    console.log('WARN — local dashboard auth is disabled; production requires DASHBOARD_AUTH_TOKEN');
  }

  // 11. Project launch readiness
  console.log('\nProject launch readiness:');
  const runDeepLaunchAudit = /^(1|true|yes)$/i.test(process.env.ORGANISM_HEALTH_DEEP_AUDIT ?? '');
  for (const policy of listProjectPolicies()) {
    const readiness = getProjectLaunchReadiness(policy.projectId);
    const audit = runDeepLaunchAudit ? getProjectLaunchAudit(policy.projectId) : null;
    const blockerLabel = readiness.blockers.length === 0 ? 'ready' : `blocked (${readiness.blockers.length})`;
    const launchAuditLabel = audit
      ? `${audit.summary.fail} fail / ${audit.summary.warn} warn`
      : 'skipped (set ORGANISM_HEALTH_DEEP_AUDIT=1)';
    console.log(`- ${policy.projectId}: ${blockerLabel}, clean=${readiness.cleanWorktree}, deployUnlocked=${readiness.deployUnlocked}, minimax=${readiness.minimax.ready ? 'ready' : 'off/not-ready'}, launchAudit=${launchAuditLabel}`);
    for (const blocker of readiness.blockers) {
      console.log(`  blocker: ${blocker}`);
    }
    for (const blocker of audit?.blockers.slice(0, 5) ?? []) {
      console.log(`  launch blocker: ${blocker}`);
    }
    for (const warning of readiness.warnings) {
      console.log(`  warning: ${warning}`);
    }
    if (readiness.blockers.length > 0 && policy.projectId === 'organism') {
      allOk = false;
    }
  }

  console.log(`\n${allOk ? '✓ All checks passed. Safe to start agents.' : '✗ Fix the issues above before running agents.'}\n`);

  if (!allOk) process.exit(1);
}

healthCheck().catch((err) => {
  console.error('Health check crashed:', err);
  process.exit(1);
});
