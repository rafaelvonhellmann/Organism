import * as crypto from 'crypto';
import { getDb } from './task-queue.js';
import { getSecretOrNull } from '../../shared/src/secrets.js';
import { GateId, GateDecision, GateRecord } from '../../shared/src/types.js';
import { OrganismError } from '../../shared/src/error-taxonomy.js';

// G1: Automated check (tests pass, budget within cap, no error codes)
// G2: Quality Agent sign-off
// G3: Full pipeline review complete
// G4: Rafael (human) board gate — via Telegram notification

export function createGate(taskId: string, gate: GateId, patchPath?: string): GateRecord {
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO gates (id, task_id, gate, decision, patch_path)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(id, taskId, gate, patchPath ?? null);
  return getGate(id)!;
}

export function evaluateG1(taskId: string, checks: { testsPassed: boolean; withinBudget: boolean; noErrors: boolean }): GateRecord {
  const gate = createGate(taskId, 'G1');
  const passed = checks.testsPassed && checks.withinBudget && checks.noErrors;
  const decision: GateDecision = passed ? 'approved' : 'rejected';
  const reason = passed
    ? 'All automated checks passed'
    : [
        !checks.testsPassed ? 'Tests failed' : null,
        !checks.withinBudget ? 'Budget exceeded' : null,
        !checks.noErrors ? 'Error codes detected' : null,
      ].filter(Boolean).join('; ');

  return updateGate(gate.id, decision, 'auto', reason);
}

// G4 is triggered by the orchestrator when a HIGH-risk task completes the full pipeline.
// The Telegram notification is sent from here; the human approves/rejects via inline button.
export function triggerG4Gate(taskId: string, summary: string): GateRecord {
  const gate = createGate(taskId, 'G4');
  // Telegram notification (placeholder — real implementation uses MCP Telegram tools)
  sendTelegramG4Notification(taskId, gate.id, summary);
  return gate;
}

// Called when Rafael clicks APPROVE or REJECT in Telegram
export function resolveG4Gate(gateId: string, decision: 'approved' | 'rejected', reason?: string): GateRecord {
  return updateGate(gateId, decision, 'rafael', reason);
}

function updateGate(gateId: string, decision: GateDecision, decidedBy: string, reason?: string): GateRecord {
  getDb().prepare(`
    UPDATE gates SET decision = ?, decided_by = ?, reason = ?, decided_at = ?
    WHERE id = ?
  `).run(decision, decidedBy, reason ?? null, Date.now(), gateId);
  return getGate(gateId)!;
}

export function getGate(gateId: string): GateRecord | null {
  const row = getDb().prepare('SELECT * FROM gates WHERE id = ?').get(gateId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    gate: row.gate as GateId,
    decision: row.decision as GateDecision,
    decidedBy: (row.decided_by as 'auto' | 'rafael' | undefined) ?? 'auto',
    reason: row.reason as string | undefined,
    decidedAt: row.decided_at as number | undefined,
    patchPath: row.patch_path as string | undefined,
  };
}

export function getPendingG4Gates(): GateRecord[] {
  const rows = getDb().prepare(
    "SELECT * FROM gates WHERE gate = 'G4' AND decision = 'pending' ORDER BY created_at ASC"
  ).all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    taskId: row.task_id as string,
    gate: row.gate as GateId,
    decision: row.decision as GateDecision,
    decidedBy: (row.decided_by as 'auto' | 'rafael' | undefined) ?? 'auto',
    reason: row.reason as string | undefined,
    decidedAt: row.decided_at as number | undefined,
    patchPath: row.patch_path as string | undefined,
  }));
}

function sendTelegramG4Notification(taskId: string, gateId: string, summary: string): void {
  const botToken = getSecretOrNull('TELEGRAM_BOT_TOKEN');
  const chatId = getSecretOrNull('TELEGRAM_CHAT_ID');

  const message =
    `🔴 *Organism G4 Gate — Board Approval Required*\n\n` +
    `*Task:* \`${taskId.slice(0, 8)}\`\n` +
    `*Gate:* \`${gateId.slice(0, 8)}\`\n\n` +
    `*Summary:*\n${summary.slice(0, 800)}\n\n` +
    `To approve:\n\`resolveG4Gate('${gateId}', 'approved')\`\n` +
    `To reject:\n\`resolveG4Gate('${gateId}', 'rejected')\``;

  if (botToken && chatId) {
    // Send via Telegram Bot API (fire-and-forget — gate is already recorded in DB)
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
    }).catch((err) => {
      console.error(`[G4 GATE] Telegram send failed: ${err.message}`);
    });
    console.log(`[G4 GATE] Telegram notification sent to chat ${chatId}`);
  } else {
    // No Telegram configured — log prominently
    console.log('\n' + '='.repeat(60));
    console.log('[G4 GATE] *** BOARD APPROVAL REQUIRED ***');
    console.log(`Task: ${taskId}`);
    console.log(`Gate: ${gateId}`);
    console.log(`Summary: ${summary.slice(0, 200)}`);
    console.log('Add TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to .secrets.json for Telegram notifications.');
    console.log('='.repeat(60) + '\n');
  }
}

// Guardian "Propose, Never Surprise" — auto-apply safe patches after 24h with no rejection
export function processStagedPatches(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const pending = getDb().prepare(`
    SELECT * FROM gates WHERE gate = 'G4' AND decision = 'pending'
    AND patch_path IS NOT NULL AND created_at < ?
  `).all(cutoff) as Record<string, unknown>[];

  for (const row of pending) {
    const patchPath = row.patch_path as string;
    // Check if it's a safe patch (formatting/data only — no logic changes)
    if (isSafePatch(patchPath)) {
      applyPatch(patchPath);
      updateGate(row.id as string, 'approved', 'auto', 'Safe patch auto-applied after 24h (no rejection)');
    }
  }
}

function isSafePatch(_patchPath: string): boolean {
  // TODO: Parse the patch and check: only whitespace, formatting, or data changes — no logic
  return false; // Conservative default until implemented
}

function applyPatch(_patchPath: string): void {
  // TODO: Apply the patch file using git apply or direct file writes
  throw new Error(`${OrganismError.AUTO_FIX_REGRESSION}: Patch application not yet implemented`);
}
