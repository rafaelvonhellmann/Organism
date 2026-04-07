/**
 * Scheduler — enforces frequencyTier constraints from capability-registry.json.
 *
 * Creates scheduled tasks for agents when their frequency tier is due,
 * then dispatches. This ensures frequency tiers actually control when
 * each agent runs, rather than dispatching ALL pending tasks globally.
 */

import { dispatchPendingTasks } from './agent-runner.js';
import { runWatchdog } from './orchestrator.js';
import { loadRegistry } from './registry.js';
import { createTask, getPendingTasks } from './task-queue.js';
import { AgentCapability } from '../../shared/src/types.js';

// --- Types ---

export interface SchedulerEntry {
  agent: string;
  frequencyTier: AgentCapability['frequencyTier'];
  lastRunAt: number | null;
  nextRunAt: number | null;
}

// In-memory map of agent → last dispatch timestamp.
// Resets on daemon restart — acceptable for Week 2.
const lastRunMap = new Map<string, number>();

let watchdogLastRunAt = 0;
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// --- Core logic ---

/**
 * Returns true if the agent should run now given its frequency tier and last run time.
 */
export function shouldRunNow(
  frequencyTier: AgentCapability['frequencyTier'],
  lastRunAt: number | null,
): boolean {
  const now = new Date();
  const nowMs = now.getTime();

  switch (frequencyTier) {
    case 'always-on':
      return true;

    case 'on-demand':
      return false;

    case 'daily': {
      // Trigger once per day after 07:00 local time
      const afterSevenAm = now.getHours() >= 7;
      if (!afterSevenAm) return false;
      if (lastRunAt === null) return true;
      const lastRunDate = new Date(lastRunAt).toDateString();
      const todayDate = now.toDateString();
      return lastRunDate !== todayDate;
    }

    case '2-3x-week': {
      // Mon (1), Wed (3), Fri (5)
      const day = now.getDay();
      if (day !== 1 && day !== 3 && day !== 5) return false;
      if (lastRunAt === null) return true;
      const lastRunDate = new Date(lastRunAt).toDateString();
      const todayDate = now.toDateString();
      return lastRunDate !== todayDate;
    }

    case 'weekly': {
      // Monday only
      if (now.getDay() !== 1) return false;
      if (lastRunAt === null) return true;
      const lastRunDate = new Date(lastRunAt).toDateString();
      const todayDate = now.toDateString();
      return lastRunDate !== todayDate;
    }

    case 'monthly': {
      // First Monday of the month
      if (now.getDay() !== 1) return false;
      if (now.getDate() > 7) return false; // first Monday is always in days 1-7
      if (lastRunAt === null) return true;
      const lastRun = new Date(lastRunAt);
      const sameMonth =
        lastRun.getFullYear() === now.getFullYear() &&
        lastRun.getMonth() === now.getMonth();
      return !sameMonth;
    }

    default:
      return false;
  }
}

/**
 * Compute the next expected run timestamp for display purposes.
 * Returns null for on-demand tiers.
 */
function computeNextRunAt(
  frequencyTier: AgentCapability['frequencyTier'],
  lastRunAt: number | null,
): number | null {
  const now = new Date();

  switch (frequencyTier) {
    case 'always-on':
      return Date.now(); // always eligible

    case 'on-demand':
      return null;

    case 'daily': {
      // Next 07:00 local time
      const next = new Date(now);
      next.setHours(7, 0, 0, 0);
      if (next.getTime() <= Date.now()) {
        next.setDate(next.getDate() + 1);
      }
      // If already ran today, show tomorrow's 07:00
      if (lastRunAt !== null) {
        const lastDate = new Date(lastRunAt).toDateString();
        if (lastDate === now.toDateString()) {
          next.setDate(next.getDate() + 1);
        }
      }
      return next.getTime();
    }

    case '2-3x-week': {
      const targetDays = [1, 3, 5]; // Mon, Wed, Fri
      const todayDay = now.getDay();
      const todayStr = now.toDateString();
      const alreadyRanToday = lastRunAt !== null && new Date(lastRunAt).toDateString() === todayStr;

      // Find next eligible day
      for (let offset = alreadyRanToday ? 1 : 0; offset <= 7; offset++) {
        const candidate = new Date(now);
        candidate.setDate(now.getDate() + offset);
        if (targetDays.includes(candidate.getDay())) {
          candidate.setHours(0, 0, 0, 0);
          return candidate.getTime();
        }
      }
      return null;
    }

    case 'weekly': {
      const todayStr = now.toDateString();
      const alreadyRanToday = lastRunAt !== null && new Date(lastRunAt).toDateString() === todayStr;
      const daysUntilMonday = ((1 - now.getDay() + 7) % 7) || (alreadyRanToday ? 7 : 0);
      const next = new Date(now);
      next.setDate(now.getDate() + daysUntilMonday);
      next.setHours(0, 0, 0, 0);
      return next.getTime();
    }

    case 'monthly': {
      // First Monday of next month if already ran this month
      const target = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      while (target.getDay() !== 1) {
        target.setDate(target.getDate() + 1);
      }
      return target.getTime();
    }

    default:
      return null;
  }
}

/**
 * Friendly tier label for scheduled task descriptions.
 */
function tierLabel(tier: AgentCapability['frequencyTier']): string {
  switch (tier) {
    case 'always-on': return 'continuous';
    case 'daily': return 'daily';
    case '2-3x-week': return 'bi-weekly';
    case 'weekly': return 'weekly';
    case 'monthly': return 'monthly';
    case 'on-demand': return 'on-demand';
    default: return String(tier);
  }
}

/**
 * One scheduling tick — checks all agents in the registry and creates
 * scheduled tasks for agents that are due, then dispatches.
 */
async function schedulerTick(): Promise<void> {
  const capabilities = loadRegistry();

  // Deduplicate by owner — each agent dispatches once per tick at most
  const agentTierMap = new Map<string, { tier: AgentCapability['frequencyTier']; description: string }>();
  for (const cap of capabilities) {
    if (!agentTierMap.has(cap.owner)) {
      agentTierMap.set(cap.owner, { tier: cap.frequencyTier, description: cap.description });
    }
  }

  let createdTasks = false;

  for (const [agent, { tier, description }] of agentTierMap) {
    // on-demand agents only run when tasks are explicitly created for them
    if (tier === 'on-demand') continue;

    const lastRunAt = lastRunMap.get(agent) ?? null;
    if (shouldRunNow(tier, lastRunAt)) {
      // Check if the agent already has pending tasks — no need to create a scheduled one
      const existingPending = getPendingTasks(agent);
      if (existingPending.length > 0) {
        console.log(`[Scheduler] ${agent} already has ${existingPending.length} pending task(s) — skipping scheduled task creation`);
        lastRunMap.set(agent, Date.now());
        createdTasks = true;
        continue;
      }

      console.log(`[Scheduler] Creating scheduled ${tierLabel(tier)} task for ${agent}`);
      try {
        createTask({
          agent,
          lane: 'LOW',
          description: `Scheduled ${tierLabel(tier)} review for ${agent}: ${description.slice(0, 120)}`,
          input: {
            scheduledBy: 'scheduler',
            frequencyTier: tier,
            scheduledAt: new Date().toISOString(),
          },
          projectId: 'organism',
        });
        lastRunMap.set(agent, Date.now());
        createdTasks = true;
      } catch (err) {
        // Duplicate detection may fire if the same scheduled task was already created today
        console.warn(`[Scheduler] Skipped ${agent}: ${(err as Error).message}`);
        lastRunMap.set(agent, Date.now()); // Mark as run to avoid retry spam
      }
    }
  }

  // Dispatch all pending tasks (including any we just created)
  if (createdTasks || getPendingTasks().length > 0) {
    try {
      await dispatchPendingTasks();
    } catch (err) {
      console.error(`[Scheduler] Error during dispatch:`, err);
    }
  }

  // Watchdog every 5 minutes
  if (Date.now() - watchdogLastRunAt >= WATCHDOG_INTERVAL_MS) {
    runWatchdog();
    watchdogLastRunAt = Date.now();
  }
}

/**
 * Return current scheduler status for dashboard display.
 */
export function getSchedulerStatus(): SchedulerEntry[] {
  const capabilities = loadRegistry();
  const agentTierMap = new Map<string, AgentCapability['frequencyTier']>();
  for (const cap of capabilities) {
    if (!agentTierMap.has(cap.owner)) {
      agentTierMap.set(cap.owner, cap.frequencyTier);
    }
  }

  const entries: SchedulerEntry[] = [];
  for (const [agent, tier] of agentTierMap) {
    const lastRunAt = lastRunMap.get(agent) ?? null;
    entries.push({
      agent,
      frequencyTier: tier,
      lastRunAt,
      nextRunAt: computeNextRunAt(tier, lastRunAt),
    });
  }
  return entries.sort((a, b) => a.agent.localeCompare(b.agent));
}

/**
 * Start the scheduling loop.
 * @param intervalMs - how often the loop ticks (default 60s)
 * @returns interval handle — call clearInterval(handle) to stop
 */
export function startScheduler(intervalMs = 60_000): ReturnType<typeof setInterval> {
  console.log(`[Scheduler] Started — ticking every ${intervalMs / 1000}s`);

  // Run immediately on start
  schedulerTick().catch(console.error);

  return setInterval(() => {
    schedulerTick().catch(console.error);
  }, intervalMs);
}
