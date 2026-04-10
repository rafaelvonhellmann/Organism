/**
 * Agent Runner — the polling loop that dispatches pending tasks to concrete agent implementations.
 *
 * This is the engine that makes Organism work. Without this running, tasks sit in the DB forever.
 *
 * Two modes:
 * 1. Daemon: startDaemon(intervalMs) — polls continuously (production use)
 * 2. One-shot: dispatchPendingTasks() — dispatch once and return (tests, scripts)
 */

import { getPendingTasks, getRecentCompletedTasks, markQualityReviewed, createTask, releaseRetryScheduledTasks } from './task-queue.js';
import { BaseAgent } from '../../../agents/_base/agent.js';
import { isRateLimited, getRateLimitStatus } from '../../../agents/_base/mcp-client.js';

// Concrete agent implementations — add each new agent here as it's built.
// The key must match the `owner` field in capability-registry.json.
import CeoAgent from '../../../agents/ceo/agent.js';
import ProductManagerAgent from '../../../agents/product-manager/agent.js';
import QualityAgent from '../../../agents/quality/quality-agent/agent.js';
import GrillMeAgent from '../../../agents/quality/grill-me/agent.js';
import EngineeringAgent from '../../../agents/engineering/agent.js';
import MarketingExecutorAgent from '../../../agents/marketing-executor/agent.js';
import SeoAgent from '../../../agents/seo/agent.js';
import DesignAgent from '../../../agents/design/agent.js';
import DevOpsAgent from '../../../agents/devops/agent.js';
import CodexReviewAgent from '../../../agents/quality/codex-review/agent.js';
import QualityGuardianAgent from '../../../agents/quality/quality-guardian/agent.js';
import CfoAgent from '../../../agents/cfo/agent.js';
import LegalAgent from '../../../agents/legal/agent.js';
import SalesAgent from '../../../agents/sales/agent.js';
import CtoAgent from '../../../agents/cto/agent.js';
import HrAgent from '../../../agents/hr/agent.js';
import CustomerSuccessAgent from '../../../agents/customer-success/agent.js';
import MedicalContentReviewerAgent from '../../../agents/medical-content-reviewer/agent.js';
import DataAnalystAgent from '../../../agents/data-analyst/agent.js';
import SecurityAuditAgent from '../../../agents/security-audit/agent.js';
import MarketingStrategistAgent from '../../../agents/marketing-strategist/agent.js';
import PrCommsAgent from '../../../agents/pr-comms/agent.js';
import CommunityManagerAgent from '../../../agents/community-manager/agent.js';
import SynthesisAgent from '../../../agents/synthesis/agent.js';
import PalateWikiAgent from '../../../agents/palate-wiki/agent.js';

type AgentConstructor = new () => BaseAgent;

// Registry: agent name → implementation class.
// Key must match the `owner` field in knowledge/capability-registry.json.
const AGENT_MAP: Record<string, AgentConstructor> = {
  'ceo': CeoAgent,
  'product-manager': ProductManagerAgent,
  'quality-agent': QualityAgent,
  'grill-me': GrillMeAgent,
  'engineering': EngineeringAgent,
  'marketing-executor': MarketingExecutorAgent,
  'seo': SeoAgent,
  'design': DesignAgent,
  'devops': DevOpsAgent,
  'codex-review': CodexReviewAgent,
  'quality-guardian': QualityGuardianAgent,
  'cfo': CfoAgent,
  'legal': LegalAgent,
  'sales': SalesAgent,
  'cto': CtoAgent,
  'hr': HrAgent,
  'customer-success': CustomerSuccessAgent,
  'medical-content-reviewer': MedicalContentReviewerAgent,
  'data-analyst': DataAnalystAgent,
  'security-audit': SecurityAuditAgent,
  'marketing-strategist': MarketingStrategistAgent,
  'pr-comms': PrCommsAgent,
  'community-manager': CommunityManagerAgent,
  'synthesis': SynthesisAgent,
  'palate-wiki': PalateWikiAgent,
};

// ── Agent priority levels for parallel dispatch ────────────────────────────
// Level 0: grill-me (must run first for MEDIUM/HIGH tasks)
// Level 1: all primary agents (CEO, CTO, engineering, etc.) — can run in parallel
// Level 2: quality-agent, codex-review, quality-guardian — depend on level 1 outputs
// Level 3: synthesis — depends on everything
const AGENT_PRIORITY: Record<string, number> = {
  'grill-me': 0,
  'quality-agent': 2,
  'codex-review': 2,
  'quality-guardian': 2,
  'synthesis': 3,
};
// Everything not listed defaults to priority 1

function getAgentPriority(agentName: string): number {
  return AGENT_PRIORITY[agentName] ?? 1;
}

/**
 * Dispatch all pending tasks to their registered agent implementations.
 * Groups agents by priority level and runs agents within the same level
 * in parallel using Promise.allSettled. Levels execute sequentially.
 */
export async function dispatchPendingTasks(): Promise<number> {
  const retryRelease = releaseRetryScheduledTasks();
  if (retryRelease.released > 0 || retryRelease.paused > 0) {
    console.log(`[Runner] Retry release: ${retryRelease.released} task(s) resumed, ${retryRelease.paused} task(s) paused after exhausting retry attempts`);
  }

  // Check rate limit before doing anything
  if (isRateLimited()) {
    const status = getRateLimitStatus();
    const resetDate = status.resetsAt ? new Date(status.resetsAt) : null;
    console.log(`[Runner] Rate limited — pausing until ${resetDate?.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }) ?? 'unknown'}. ${Math.ceil(((status.resetsAt ?? 0) - Date.now()) / 60000)}min remaining.`);
    return 0;
  }

  const pending = getPendingTasks();
  if (pending.length === 0) return 0;

  // Unique agent names with pending tasks, grouped by priority level
  const agentNames = [...new Set(pending.map((t) => t.agent))];
  const levelMap = new Map<number, string[]>();

  for (const name of agentNames) {
    const level = getAgentPriority(name);
    const group = levelMap.get(level) ?? [];
    group.push(name);
    levelMap.set(level, group);
  }

  // Sort levels ascending so level 0 runs before level 1, etc.
  const sortedLevels = [...levelMap.keys()].sort((a, b) => a - b);

  let dispatched = 0;

  for (const level of sortedLevels) {
    const agentsAtLevel = levelMap.get(level)!;

    // Re-check rate limit before each level
    if (isRateLimited()) {
      const status = getRateLimitStatus();
      console.log(`[Runner] Rate limit hit before level ${level}. ${agentsAtLevel.length} agent(s) deferred. Usage: ${status.usagePct.toFixed(0)}%`);
      break;
    }

    // Build runnable promises for this level — skip unregistered agents
    const runnables: Array<{ name: string; promise: () => Promise<void> }> = [];
    for (const agentName of agentsAtLevel) {
      const AgentClass = AGENT_MAP[agentName];
      if (!AgentClass) {
        console.warn(`[Runner] No implementation registered for '${agentName}'. Add it to AGENT_MAP in agent-runner.ts.`);
        continue;
      }
      runnables.push({
        name: agentName,
        promise: () => {
          const agent = new AgentClass();
          return agent.run();
        },
      });
    }

    if (runnables.length === 0) continue;

    if (runnables.length === 1) {
      // Single agent at this level — run directly (no allSettled overhead)
      try {
        await runnables[0].promise();
        dispatched++;
      } catch (err) {
        console.error(`[Runner] Agent '${runnables[0].name}' failed:`, err);
      }
    } else {
      // Multiple agents at this level — run in parallel
      console.log(`[Runner] Level ${level}: dispatching ${runnables.length} agents in parallel: ${runnables.map(r => r.name).join(', ')}`);
      const results = await Promise.allSettled(runnables.map(r => r.promise()));

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          dispatched++;
        } else {
          console.error(`[Runner] Agent '${runnables[i].name}' failed:`, result.reason);
        }
      }
    }

    // Re-check rate limit after each level completes
    if (isRateLimited()) {
      const status = getRateLimitStatus();
      console.log(`[Runner] Rate limit hit after level ${level}. Remaining levels deferred. Usage: ${status.usagePct.toFixed(0)}%`);
      break;
    }
  }

  // After all agents complete, batch quality reviews instead of 1:1 per task
  await batchQualityReviews();

  return dispatched;
}

/**
 * Collect recently completed tasks that haven't been quality-reviewed,
 * and create ONE batched quality-agent task per group of 5+ instead of one per task.
 */
async function batchQualityReviews(): Promise<void> {
  const completed = getRecentCompletedTasks(20);
  const needsQualityReview = completed.filter(t =>
    !t.agent.startsWith('quality') &&
    !t.agent.startsWith('grill-me') &&
    !t.agent.startsWith('codex-review')
  );

  if (needsQualityReview.length >= 5) {
    try {
      createTask({
        agent: 'quality-agent',
        lane: 'LOW',
        description: `Batch quality review: ${needsQualityReview.length} tasks`,
        input: {
          batchedOutputs: needsQualityReview.map(t => ({
            taskId: t.id,
            agent: t.agent,
            description: t.description.slice(0, 100),
            outputSummary: typeof t.output === 'string'
              ? t.output.slice(0, 500)
              : JSON.stringify(t.output).slice(0, 500),
          })),
        },
        projectId: needsQualityReview[0]?.projectId ?? 'organism',
      });

      // Mark these tasks as quality-reviewed so they are not batched again
      markQualityReviewed(needsQualityReview.map(t => t.id));
      console.log(`[Runner] Batched quality review created for ${needsQualityReview.length} tasks`);
    } catch (err) {
      // Duplicate detection may fire if we already batched the same set — safe to ignore
      console.warn(`[Runner] Batch quality review skipped:`, (err as Error).message);
    }
  }
}

/**
 * Start continuous polling daemon.
 * @param intervalMs - polling interval (default 10s)
 * @returns interval handle — call clearInterval(handle) to stop
 */
export function startDaemon(intervalMs = 10_000): ReturnType<typeof setInterval> {
  console.log(`[Runner] Daemon started — polling every ${intervalMs / 1000}s`);
  console.log(`[Runner] Registered agents: ${Object.keys(AGENT_MAP).join(', ')}`);

  // Dispatch immediately, then on interval
  dispatchPendingTasks().catch(console.error);

  return setInterval(async () => {
    // If rate limited, check if it's time to resume
    if (isRateLimited()) {
      const status = getRateLimitStatus();
      const msUntilReset = (status.resetsAt ?? 0) - Date.now();
      if (msUntilReset > 0) {
        // Only log every 5 minutes to avoid spam
        if (msUntilReset % (5 * 60 * 1000) < intervalMs) {
          console.log(`[Runner] Rate limited — ${Math.ceil(msUntilReset / 60000)}min until reset`);
        }
        return;
      }
      // Reset time passed — isRateLimited() will clear the flag on next call
      console.log(`[Runner] Rate limit reset — resuming operations`);
    }

    try {
      await dispatchPendingTasks();
    } catch (err) {
      console.error('[Runner] Dispatch error:', err);
    }
  }, intervalMs);
}
