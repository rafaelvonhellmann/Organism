import { classifyRisk } from './risk-classifier.js';
import { createTask, checkoutTask, completeTask, failTask, reapDeadLetters, getPendingTasks, getDeadLetterTasks } from './task-queue.js';
import { assertBudget, recordSpend, getSpendSummary, getTaskBudget } from './budget.js';
import { writeAudit } from './audit.js';
import { loadRegistry, resolveOwner } from './registry.js';
import { RiskLane, PerspectiveReviewResult } from '../../shared/src/types.js';
import { OrganismError } from '../../shared/src/error-taxonomy.js';
import { runPerspectiveReview } from './perspective-runner.js';
import {
  getBet, getActiveBetForProject, checkBetCircuitBreaker, checkBetBoundaries,
  recordBetSpend, resolveSpecialistTriggers,
} from './shapeup.js';

// Orchestrator is the single main loop. Agents submit tasks here.
// Paperclip is the ONLY orchestrator — PraisonAI is a tool provider only.

type AgentModel = 'haiku' | 'sonnet' | 'opus';

/**
 * Smart model routing — overrides the agent's default model based on
 * task complexity and agent role. Saves cost on classification/interrogation
 * while keeping quality-sensitive agents strong.
 *
 * NEVER DOWNGRADE: legal, security-audit, quality-guardian, medical-content-reviewer
 * USE CHEAPER: grill-me, codex-review (uses GPT via own agent), risk-classifier
 */
export function selectModel(agent: string, _lane: RiskLane): AgentModel {
  // Cheap: classification, interrogation, formatting, triage
  if (agent === 'grill-me') return 'haiku';
  if (agent === 'codex-review') return 'haiku';  // codex-review uses GPT via its own agent
  if (agent === 'risk-classifier') return 'haiku';

  // Quality-sensitive: NEVER downgrade these
  if (agent === 'quality-guardian') return 'sonnet';
  if (agent === 'legal') return 'sonnet';
  if (agent === 'security-audit') return 'sonnet';
  if (agent === 'medical-content-reviewer') return 'sonnet';

  // Everything else: Sonnet
  return 'sonnet';
}

export interface SubmitTaskOptions {
  agent?: string;        // Override resolved agent (for explicit delegation)
  parentTaskId?: string;
  loc?: number;          // Lines of code changed (for risk classification)
  projectId?: string;    // Project this task belongs to (default: 'organism')
  betId?: string;        // Linked Shape Up bet (required for MEDIUM/HIGH unless emergency)
  emergency?: boolean;   // Bypass shaping requirement (logged prominently)
}

export interface TaskSubmission {
  description: string;
  input: unknown;
  projectId?: string;    // Can also be set here; options.projectId takes precedence
}

/**
 * Shape Up routing result — determines how a MEDIUM/HIGH task is handled
 * when no approved bet is referenced.
 */
export type ShapingAction =
  | { type: 'proceed'; betId?: string }          // bet found or LOW risk
  | { type: 'convert_to_pitch' }                 // reroute to shaping
  | { type: 'emergency'; reason: string }         // explicit emergency bypass
  | { type: 'rejected'; reason: string };          // no bet, no emergency

/**
 * Determine whether a MEDIUM/HIGH task can proceed or needs shaping.
 */
function resolveShapingRequirement(
  lane: RiskLane,
  projectId: string,
  options: SubmitTaskOptions,
): ShapingAction {
  // LOW tasks always proceed — no shaping required
  if (lane === 'LOW') {
    return { type: 'proceed', betId: options.betId };
  }

  // Explicit bet reference — validate it exists and is active/approved
  if (options.betId) {
    const bet = getBet(options.betId);
    if (!bet) {
      return { type: 'rejected', reason: `Referenced bet ${options.betId} does not exist` };
    }
    if (bet.status !== 'active' && bet.status !== 'bet_approved') {
      return { type: 'rejected', reason: `Bet ${options.betId} is in status '${bet.status}', not active/approved` };
    }

    // Check circuit breaker before allowing more work
    const breaker = checkBetCircuitBreaker(options.betId);
    if (breaker.tripped) {
      return { type: 'rejected', reason: `Bet circuit breaker tripped: ${breaker.reason}` };
    }

    // Check boundary violations
    // Note: we pass empty string for description here; actual description check is in submitTask
    return { type: 'proceed', betId: options.betId };
  }

  // Explicit emergency bypass
  if (options.emergency) {
    return { type: 'emergency', reason: 'Task submitted with emergency flag — shaping bypassed' };
  }

  // Try to find an active bet for this project
  const activeBet = getActiveBetForProject(projectId);
  if (activeBet) {
    // Check circuit breaker
    const breaker = checkBetCircuitBreaker(activeBet.id);
    if (!breaker.tripped) {
      return { type: 'proceed', betId: activeBet.id };
    }
  }

  // No approved bet found — convert to shaping pitch
  return { type: 'convert_to_pitch' };
}

// Main entry point: submit a task for processing
export async function submitTask(
  submission: TaskSubmission,
  options: SubmitTaskOptions = {}
): Promise<string> {
  // 1. Classify risk
  const classification = await classifyRisk(submission.description, { loc: options.loc });

  // 2. Resolve owning agent (project-scoped when projectId is set)
  const projectId = options.projectId ?? submission.projectId ?? 'organism';
  loadRegistry(); // warm cache
  let intendedAgent = options.agent;
  if (!intendedAgent) {
    const resolved = resolveOwner(submission.description, projectId === 'organism' ? undefined : projectId);
    intendedAgent = resolved?.owner ?? 'ceo'; // CEO handles ambiguous and unknown tasks
  }

  // 3. Shape Up gate: MEDIUM/HIGH tasks must reference an approved bet or be rerouted
  const shapingAction = resolveShapingRequirement(classification.lane, projectId, options);

  if (shapingAction.type === 'rejected') {
    writeAudit({
      agent: intendedAgent,
      taskId: 'rejected',
      action: 'gate_eval',
      payload: { type: 'shaping_rejected', reason: shapingAction.reason, description: submission.description },
      outcome: 'blocked',
    });
    throw new Error(`Shape Up gate: ${shapingAction.reason}`);
  }

  if (shapingAction.type === 'convert_to_pitch') {
    // Instead of executing, create a shaping task routed to product-manager
    // Grill-Me is used upstream here for pitch refinement, not as a blanket gate
    const agent = 'product-manager';
    const task = createTask({
      agent,
      lane: classification.lane,
      description: `[SHAPING] ${submission.description}`,
      input: {
        type: 'pitch_request',
        originalDescription: submission.description,
        originalInput: submission.input,
        intendedAgent,
        reason: 'No approved bet found for MEDIUM/HIGH task — needs shaping first',
      },
      parentTaskId: options.parentTaskId,
      projectId,
    });

    writeAudit({
      agent,
      taskId: task.id,
      action: 'task_created',
      payload: { classification, description: submission.description, shapingAction: 'convert_to_pitch' },
      outcome: 'success',
    });

    return task.id;
  }

  if (shapingAction.type === 'emergency') {
    writeAudit({
      agent: intendedAgent,
      taskId: 'emergency',
      action: 'gate_eval',
      payload: { type: 'emergency_bypass', reason: shapingAction.reason, description: submission.description },
      outcome: 'success',
    });
  }

  const resolvedBetId = shapingAction.type === 'proceed' ? shapingAction.betId : undefined;

  // 4. Boundary check if we have a bet
  if (resolvedBetId) {
    const boundaryCheck = checkBetBoundaries(resolvedBetId, submission.description);
    if (boundaryCheck.tripped) {
      writeAudit({
        agent: intendedAgent,
        taskId: 'boundary_violation',
        action: 'gate_eval',
        payload: { type: 'boundary_violation', betId: resolvedBetId, reason: boundaryCheck.reason },
        outcome: 'blocked',
      });
      throw new Error(`Bet boundary violation: ${boundaryCheck.reason}`);
    }
  }

  // 5. Route to agent — Grill-Me is no longer a blanket gate for all MEDIUM/HIGH tasks.
  //    Instead, it is used upstream in pitch refinement (product-manager delegates to grill-me
  //    during shaping). Once a bet is approved, tasks go directly to the intended agent.
  const agent = intendedAgent;
  const taskInput = submission.input;

  // 6. Create task record
  const task = createTask({
    agent,
    lane: classification.lane,
    description: submission.description,
    input: taskInput,
    parentTaskId: options.parentTaskId,
    projectId,
    betId: resolvedBetId,
  });

  writeAudit({
    agent,
    taskId: task.id,
    action: 'task_created',
    payload: { classification, description: submission.description, betId: resolvedBetId },
    outcome: 'success',
  });

  // 7. Route to pipeline (async — the pipeline runs the actual agent session)
  routeToPipeline(task.id, agent, classification.lane, resolvedBetId).catch((err) => {
    writeAudit({
      agent,
      taskId: task.id,
      action: 'error',
      payload: { message: err.message },
      outcome: 'failure',
      errorCode: OrganismError.AGENT_TIMEOUT,
    });
    failTask(task.id, err.message);
  });

  return task.id;
}

export async function submitPerspectiveReview(
  projectId: string,
  scope: string,
  context: Record<string, unknown>,
  options: { maxPerspectives?: number; parentTaskId?: string } = {},
): Promise<PerspectiveReviewResult> {
  console.log(`[Orchestrator] Perspective review: ${projectId} (${scope})`);

  writeAudit({
    agent: 'orchestrator',
    taskId: 'perspective-review',
    action: 'task_created',
    payload: { projectId, scope, maxPerspectives: options.maxPerspectives },
    outcome: 'success',
  });

  return runPerspectiveReview({
    projectId,
    scope,
    context,
    maxPerspectives: options.maxPerspectives,
    parentTaskId: options.parentTaskId,
  });
}

// Pipeline routing based on risk lane
async function routeToPipeline(taskId: string, agent: string, lane: RiskLane, betId?: string): Promise<void> {
  // Pre-flight budget check using lane-based task budget estimates
  const estimatedCost = getTaskBudget(agent, lane);
  assertBudget(agent, estimatedCost);

  const pipeline = getPipelineStages(lane, agent, betId);

  writeAudit({
    agent,
    taskId,
    action: 'task_checkout',
    payload: { lane, pipeline, betId },
    outcome: 'success',
  });

  // Actual pipeline execution is handled by the agent runner (agents/_base/agent.ts)
  // The orchestrator just records routing; the agent process picks up pending tasks.
  console.log(`[Orchestrator] Task ${taskId} → ${lane} lane → agent: ${agent}${betId ? ` → bet: ${betId.slice(0, 8)}` : ''}`);
}

/**
 * Pipeline stages — now trigger-based for specialists instead of default-heavy.
 *
 * Shape Up changes:
 * - Grill-Me is no longer in the MEDIUM/HIGH runtime pipeline. It is used upstream
 *   during pitch refinement when tasks don't have an approved bet.
 * - Specialist agents (legal, security-audit, quality-guardian) are only invoked
 *   when their trigger conditions match the task description.
 * - LOW tasks remain unchanged.
 */
function getPipelineStages(lane: RiskLane, _agent?: string, betId?: string): string[] {
  switch (lane) {
    case 'LOW':
      return ['quality-agent', 'auto-ship'];
    case 'MEDIUM':
      // Removed grill-me from runtime pipeline (now upstream in shaping)
      return ['quality-agent', 'codex-review', 'auto-ship'];
    case 'HIGH': {
      // Base pipeline without blanket specialist invocation
      const stages = ['quality-agent', 'codex-review'];
      // Specialist triggers are resolved dynamically in getPipelineStagesV2
      // For backward compat, the V1 pipeline still includes G4-gate for HIGH
      stages.push('G4-gate');
      return stages;
    }
  }
}

// ── Parallelized pipeline (V2) — trigger-based specialists ──────────────────
// Groups agents that can run concurrently within each stage.
// Stages execute sequentially; agents within a stage run in parallel.
// Specialist agents are now only included when their trigger conditions are met.

export interface PipelineStage {
  agents: string[];      // agents in this stage run in parallel
  sequential: boolean;   // if true, wait for previous stage to complete first
}

export function getPipelineStagesV2(lane: RiskLane, description: string = '', betId?: string): PipelineStage[] {
  const hasBet = !!betId;
  const specialists = resolveSpecialistTriggers(description, lane, hasBet);

  switch (lane) {
    case 'LOW':
      return [
        { agents: ['quality-agent'], sequential: false },
      ];
    case 'MEDIUM':
      return [
        { agents: ['quality-agent', 'codex-review'], sequential: false },
      ];
    case 'HIGH': {
      const stages: PipelineStage[] = [
        { agents: ['quality-agent'], sequential: true },
      ];
      // Only add specialists whose triggers matched
      if (specialists.length > 0) {
        stages.push({ agents: specialists, sequential: false });
      }
      stages.push({ agents: ['codex-review'], sequential: false });
      return stages;
    }
  }
}

// Watchdog: runs periodically to reap dead letter tasks and alert
export function runWatchdog(): void {
  const reaped = reapDeadLetters();
  if (reaped > 0) {
    console.error(`[Watchdog] Moved ${reaped} stuck tasks to dead_letter. Code: ${OrganismError.DEAD_LETTER_TIMEOUT}`);
    const deadLetters = getDeadLetterTasks();
    for (const task of deadLetters) {
      writeAudit({
        agent: task.agent,
        taskId: task.id,
        action: 'error',
        payload: { message: 'Task stuck in in_progress — moved to dead_letter' },
        outcome: 'failure',
        errorCode: OrganismError.DEAD_LETTER_TIMEOUT,
      });
    }
  }
}

// Status snapshot for dashboard
export function getSystemStatus(projectId?: string) {
  const pending = getPendingTasks(undefined, projectId);
  const deadLetters = getDeadLetterTasks();
  const spend = getSpendSummary(undefined, projectId);

  return {
    pendingTasks: pending.length,
    deadLetters: deadLetters.length,
    agentSpend: spend,
    projectId: projectId ?? 'all',
    alerts: [
      ...spend.filter((s) => s.pct > 80).map((s) => `${s.agent} at ${s.pct.toFixed(0)}% of daily budget`),
      ...(deadLetters.length > 0 ? [`${deadLetters.length} dead letter task(s) need attention`] : []),
    ],
  };
}
