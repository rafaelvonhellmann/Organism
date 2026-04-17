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
import { getDb, getPendingTasks } from './task-queue.js';
import { enforceDormancy } from './perspectives.js';
import { syncToTurso } from './turso-sync.js';
import { processDashboardActions } from './action-processor.js';
import { listProjectPolicies, loadProjectPolicy, requiresHumanReviewGate, resolveEffectiveRiskLane } from './project-policy.js';
import { seedIdleAutonomyCycles } from './autonomy-loop.js';
import { AgentCapability, GoalSourceKind, ProjectPolicy, WorkflowKind } from '../../shared/src/types.js';
import { OrganismError } from '../../shared/src/error-taxonomy.js';
import { getLatestRunForGoal, updateRunStatus } from './run-state.js';

function schedulerSyncEnabled(): boolean {
  return process.env.ORGANISM_DISABLE_SCHEDULER_SYNC !== '1';
}

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

type ScheduledProjectCadence = 'daily' | 'weekly';

export interface ScheduledProjectRun {
  id: string;
  kind: 'project_review' | 'self_audit' | 'innovation_radar';
  projectId: string;
  cadence: ScheduledProjectCadence;
  dayOfWeek: number | null;
  hour: number;
  agent?: string;
  title?: string;
  description: string;
  workflowKind: WorkflowKind;
  sourceKind: GoalSourceKind;
  input: Record<string, unknown>;
  shadowMode?: boolean;
}

const DEFAULT_PROJECT_SCHEDULE: ScheduledProjectRun[] = [
  {
    id: 'weekly-review:synapse',
    kind: 'project_review',
    projectId: 'synapse',
    cadence: 'weekly',
    dayOfWeek: 1,
    hour: 9,
    agent: 'quality-agent',
    title: 'Scheduled medical-safe review of synapse',
    description: 'Scheduled medical-safe review of synapse',
    workflowKind: 'review',
    sourceKind: 'scheduler',
    input: {
      projectId: 'synapse',
      triggeredBy: 'scheduler',
      scheduledReview: true,
      reviewScope: 'project',
      medicalReadOnlyCanary: true,
      followupPolicy: {
        boundedLane: 'medical_read_only',
        allowedWorkflows: ['review', 'plan', 'validate'],
        maxFollowups: 2,
        recursionDisabled: true,
      },
    },
  },
  {
    id: 'weekly-review:tokens-for-good',
    kind: 'project_review',
    projectId: 'tokens-for-good',
    cadence: 'weekly',
    dayOfWeek: 2,
    hour: 9,
    agent: 'quality-agent',
    title: 'Scheduled weekly review of tokens-for-good',
    description: 'Scheduled weekly review of tokens-for-good',
    workflowKind: 'review',
    sourceKind: 'scheduler',
    input: {
      projectId: 'tokens-for-good',
      triggeredBy: 'scheduler',
      scheduledReview: true,
      reviewScope: 'project',
    },
  },
];

const scheduledProjectRunLastPeriod = new Map<string, string>();

function isTaskCollisionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(OrganismError.TASK_CHECKOUT_CONFLICT)
    || /Duplicate task detected/i.test(message)
    || /Active goal task already exists/i.test(message);
}

export function buildScheduledProjectRuns(policies: ProjectPolicy[] = listProjectPolicies()): ScheduledProjectRun[] {
  const scheduled = [...DEFAULT_PROJECT_SCHEDULE];

  for (const policy of policies) {
    if (policy.selfAudit.enabled) {
      scheduled.push({
        id: `self-audit:${policy.projectId}`,
        kind: 'self_audit',
        projectId: policy.projectId,
        cadence: policy.selfAudit.cadence,
        dayOfWeek: policy.selfAudit.dayOfWeek,
        hour: policy.selfAudit.hour,
        agent: 'quality-agent',
        title: `Scheduled self-audit of ${policy.projectId}`,
        description: policy.selfAudit.description,
        workflowKind: 'review',
        sourceKind: 'scheduler',
        input: {
          projectId: policy.projectId,
          triggeredBy: 'scheduler',
          scheduledReview: true,
          reviewScope: 'project',
          selfAudit: true,
          followupPolicy: {
            boundedLane: 'self_audit',
            allowedWorkflows: policy.selfAudit.workflows,
            maxFollowups: policy.selfAudit.maxFollowups,
            recursionDisabled: true,
          },
        },
      });
    }

    if (policy.innovationRadar.enabled) {
      scheduled.push({
        id: `innovation-radar:${policy.projectId}`,
        kind: 'innovation_radar',
        projectId: policy.projectId,
        cadence: policy.innovationRadar.cadence,
        dayOfWeek: policy.innovationRadar.dayOfWeek,
        hour: policy.innovationRadar.hour,
        agent: policy.innovationRadar.agent,
        title: `Innovation radar for ${policy.projectId}`,
        description: policy.innovationRadar.description,
        workflowKind: 'review',
        sourceKind: 'scheduler',
        shadowMode: policy.innovationRadar.shadow,
        input: {
          projectId: policy.projectId,
          project: policy.projectId,
          triggeredBy: 'scheduler',
          focusAreas: policy.innovationRadar.focusAreas,
          maxOpportunities: policy.innovationRadar.maxOpportunities,
          shadowMode: policy.innovationRadar.shadow,
          innovationRadar: true,
          scheduledReview: true,
        },
      });
    }
  }

  return scheduled;
}

export function autoCompleteEligibleAwaitingReviewTasks(now = Date.now()): number {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, project_id, lane, description, workflow_kind, goal_id
    FROM tasks
    WHERE status = 'awaiting_review'
  `).all() as Array<{
    id: string;
    project_id: string;
    lane: 'LOW' | 'MEDIUM' | 'HIGH';
    description: string;
    workflow_kind: WorkflowKind | null;
    goal_id: string | null;
  }>;

  let completed = 0;

  for (const row of rows) {
    const projectId = row.project_id || 'organism';
    const workflowKind = row.workflow_kind ?? 'implement';
    const policy = loadProjectPolicy(projectId);
    if (requiresHumanReviewGate(policy, row.description, workflowKind, row.lane)) continue;

    const effectiveLane = resolveEffectiveRiskLane(policy, row.description, workflowKind, row.lane);
    db.prepare(`
      UPDATE tasks
      SET status = 'completed', lane = ?, completed_at = COALESCE(completed_at, ?)
      WHERE id = ? AND status = 'awaiting_review'
    `).run(effectiveLane, now, row.id);

    if (row.goal_id) {
      const run = getLatestRunForGoal(row.goal_id);
      if (run && (run.status === 'paused' || run.status === 'retry_scheduled')) {
        updateRunStatus({
          runId: run.id,
          status: 'completed',
          summary: 'Auto-completed after the review gate reclassified this task as autonomous-safe.',
        });
      }
    }

    completed += 1;
  }

  return completed;
}

export function getSchedulePeriodKey(schedule: ScheduledProjectRun, now = new Date()): string {
  return now.toISOString().split('T')[0];
}

export function isScheduledProjectRunDue(
  schedule: ScheduledProjectRun,
  now = new Date(),
  lastRunPeriod: string | null = null,
): boolean {
  if (schedule.cadence === 'weekly') {
    if (schedule.dayOfWeek === null || now.getDay() !== schedule.dayOfWeek) return false;
  }

  if (now.getHours() < schedule.hour) return false;

  const periodKey = getSchedulePeriodKey(schedule, now);
  return lastRunPeriod !== periodKey;
}

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
      // Only create if no recent run (within last 60 min) — prevents spam
      if (lastRunAt === null) return true;
      return nowMs - lastRunAt > 60 * 60 * 1000;

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
  let createdTasks = false;

  // Pull remote dashboard actions first so website-triggered work is visible
  // during the same scheduler cycle instead of waiting for the next one.
  if (schedulerSyncEnabled()) {
    try { await syncToTurso(); } catch { /* non-critical */ }
  }

  // ── Scheduled project reviews and bounded self-audits ───────────────────
  const now = new Date();
  const schedules = buildScheduledProjectRuns();
  for (const schedule of schedules) {
    const periodKey = getSchedulePeriodKey(schedule, now);
    const lastRunPeriod = scheduledProjectRunLastPeriod.get(schedule.id) ?? null;
    if (!isScheduledProjectRunDue(schedule, now, lastRunPeriod)) continue;

    try {
      const { submitTask } = await import('./orchestrator.js');
      await submitTask({
        title: schedule.title,
        description: schedule.description,
        input: {
          ...schedule.input,
          projectId: schedule.projectId,
          dedupeKey: `${schedule.id}:${periodKey}`,
        },
        projectId: schedule.projectId,
        workflowKind: schedule.workflowKind,
        sourceKind: schedule.sourceKind,
      }, {
        agent: schedule.agent,
        projectId: schedule.projectId,
        workflowKind: schedule.workflowKind,
        sourceKind: schedule.sourceKind,
      });
      scheduledProjectRunLastPeriod.set(schedule.id, periodKey);
      console.log(`[Scheduler] Triggered ${schedule.kind.replace('_', ' ')} for ${schedule.projectId}`);
    } catch (err) {
      if (isTaskCollisionError(err)) {
        scheduledProjectRunLastPeriod.set(schedule.id, periodKey);
        console.log(`[Scheduler] ${schedule.kind.replace('_', ' ')} for ${schedule.projectId} is already queued for this period — skipping duplicate trigger`);
        continue;
      }
      console.warn(`[Scheduler] Failed to trigger ${schedule.kind} for ${schedule.projectId}:`, (err as Error).message);
    }
  }

  // ── Git-triggered reviews ─────────────────────────────────────────────
  try {
    const { checkForNewCommits, agentsForChangedFiles } = await import('./git-watcher.js');
    const newCommits = checkForNewCommits();
    for (const commit of newCommits) {
      const targetAgents = agentsForChangedFiles(commit.changedFiles);
      if (targetAgents.length > 0) {
        console.log(`[Scheduler] New commit in ${commit.projectId}: "${commit.message}" — triggering ${targetAgents.join(', ')}`);
        const { submitTask } = await import('./orchestrator.js');
        await submitTask({
          description: `Git-triggered review: ${commit.message} (${commit.changedFiles.length} files changed)`,
          input: {
            projectId: commit.projectId,
            triggeredBy: 'git-watcher',
            commit: commit.commit,
            changedFiles: commit.changedFiles,
            targetAgents,
            dedupeKey: `${commit.projectId}:${commit.commit}`,
          },
          projectId: commit.projectId,
          sourceKind: 'git_watcher',
          workflowKind: 'validate',
        });
      }
    }
  } catch { /* non-critical — git-watcher may fail if repos don't exist */ }

  // ── Progress monitoring — check if weekly objectives are being met ────
  try {
    const { checkProgressAndCreateTasks } = await import('./progress-monitor.js');
    const created = checkProgressAndCreateTasks();
    if (created > 0) {
      console.log(`[Scheduler] Progress monitor created ${created} recovery tasks`);
    }
  } catch { /* non-critical */ }

  // ── Idle autonomy loop — seed the next safe bounded review when a project goes idle ──
  try {
    const autonomyCycles = await seedIdleAutonomyCycles();
    if (autonomyCycles > 0) {
      console.log(`[Scheduler] Idle autonomy loop seeded ${autonomyCycles} project review(s)`);
      createdTasks = true;
    }
  } catch { /* non-critical */ }

  // Deduplicate by owner — each agent dispatches once per tick at most
  const agentTierMap = new Map<string, { tier: AgentCapability['frequencyTier']; description: string }>();
  for (const cap of capabilities) {
    if (!agentTierMap.has(cap.owner)) {
      agentTierMap.set(cap.owner, { tier: cap.frequencyTier, description: cap.description });
    }
  }

  // DISABLED: Generic agent-level scheduling creates tasks with no project context.
  // Progress monitor (above) creates specific objective tasks instead.
  // The weekly project reviews (Monday/Tuesday) handle full reviews.
  /*
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
  */

  // Process any actions triggered from the dashboard
  try { await processDashboardActions(); } catch { /* non-critical */ }

  // Dispatch all pending tasks (including any we just created)
  if (createdTasks || getPendingTasks().length > 0) {
    try {
      await dispatchPendingTasks();
    } catch (err) {
      console.error(`[Scheduler] Error during dispatch:`, err);
    }
  }

  // Cascading tasks — when agents complete, trigger downstream agents
  try {
    const { processCascades } = await import('./cascade.js');
    processCascades();
  } catch { /* non-critical */ }

  try {
    const completed = autoCompleteEligibleAwaitingReviewTasks();
    if (completed > 0) {
      console.log(`[Scheduler] Auto-completed ${completed} awaiting-review task(s) after policy reclassification`);
    }
  } catch { /* non-critical */ }

  // Auto-complete LOW tasks that have been awaiting_review for >1 hour with no critical issues
  // (They were already quality-reviewed and auto-approved, but might be stuck)
  try {
    const stuckLow = getDb().prepare(`
      SELECT id FROM tasks
      WHERE status = 'awaiting_review' AND lane = 'LOW'
      AND completed_at < ?
    `).all(Date.now() - 60 * 60 * 1000) as Array<{ id: string }>;

    if (stuckLow.length > 0) {
      for (const task of stuckLow) {
        getDb().prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(task.id);
      }
      console.log(`[Scheduler] Auto-completed ${stuckLow.length} stuck LOW tasks`);
    }
  } catch { /* non-critical */ }

  // Auto-execute on approved findings — create follow-up tasks
  try {
    const { processApprovedFindings } = await import('./auto-executor.js');
    const followupsCreated = await processApprovedFindings();
    if (followupsCreated > 0) {
      await dispatchPendingTasks();
    }
  } catch { /* non-critical */ }

  // Auto-dispatch any new tasks created by the agents (child tasks, quality reviews, etc.)
  // This creates a continuous processing loop where the organism keeps working
  const stillPending = getPendingTasks();
  if (stillPending.length > 0) {
    console.log(`[Scheduler] ${stillPending.length} new tasks created by agents — will dispatch next tick`);
  }

  // Darwinian dormancy: suspend underperforming perspectives
  try {
    const { suspended } = enforceDormancy();
    if (suspended.length > 0) {
      console.log(`[Scheduler] Dormancy enforced: ${suspended.join(', ')} suspended`);
    }
  } catch { /* non-critical */ }

  // Sync local state to Turso for dashboard
  if (schedulerSyncEnabled()) {
    try { await syncToTurso(); } catch { /* non-critical */ }
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
