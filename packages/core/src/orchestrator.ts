import { classifyRisk } from './risk-classifier.js';
import { createTask, checkoutTask, completeTask, reapDeadLetters, getPendingTasks, getDeadLetterTasks, updateTaskRuntimeState } from './task-queue.js';
import { assertBudget, recordSpend, getSpendSummary, getTaskBudget } from './budget.js';
import { writeAudit } from './audit.js';
import { loadRegistry, resolveOwner } from './registry.js';
import { GoalSourceKind, PerspectiveReviewResult, RiskLane, WorkflowKind } from '../../shared/src/types.js';
import { OrganismError } from '../../shared/src/error-taxonomy.js';
import { runPerspectiveReview } from './perspective-runner.js';
import { getProjectAutonomyHealth } from './autonomy-governor.js';
import {
  getBet, getActiveBetForProject, checkBetCircuitBreaker, checkBetBoundaries,
  recordBetSpend, resolveSpecialistTriggers,
} from './shapeup.js';
import { ensureGoal, getGoal, mapProviderFailure } from './run-state.js';
import { loadProjectPolicy, isActionBlocked, resolveTaskSafetyEnvelope } from './project-policy.js';

// Orchestrator is the single main loop. Agents submit tasks here.
// Paperclip is the ONLY orchestrator — PraisonAI is a tool provider only.

type AgentModel = 'haiku' | 'sonnet' | 'opus';

/**
 * Smart model routing — overrides the agent's default model based on
 * task complexity and agent role. Saves cost on classification/interrogation
 * while keeping quality-sensitive agents strong.
 *
 * NEVER DOWNGRADE: legal, security-audit, quality-guardian, medical-content-reviewer
 * USE CHEAPER: domain-model, codex-review (uses GPT via own agent), risk-classifier
 */
export function selectModel(agent: string, _lane: RiskLane): AgentModel {
  // Cheap: classification, interrogation, formatting, triage
  if (agent === 'domain-model' || agent === 'grill-me') return 'haiku';
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
  workflowKind?: WorkflowKind;
  sourceKind?: GoalSourceKind;
  goalId?: string;
}

export interface TaskSubmission {
  description: string;
  input: unknown;
  projectId?: string;    // Can also be set here; options.projectId takes precedence
  title?: string;
  sourceKind?: GoalSourceKind;
  workflowKind?: WorkflowKind;
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
  workflowKind?: WorkflowKind,
): ShapingAction {
  // LOW tasks always proceed — no shaping required
  if (lane === 'LOW') {
    return { type: 'proceed', betId: options.betId };
  }

  // Read-only or recovery-oriented workflows should not be blocked behind
  // Shape Up execution gating. They help the system inspect, validate, and
  // stabilize work without widening the implementation surface.
  if (
    workflowKind === 'review'
    || workflowKind === 'validate'
    || workflowKind === 'monitor'
    || workflowKind === 'recover'
  ) {
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

// Sensitive actions are governed by project policy.
// Stabilization blocks them today; later autonomy modes can loosen them deliberately.

function sanitizeDescription(description: string): string {
  const withoutEmbeddedJson = description
    .replace(/\n\s*\n\{[\s\S]*$/, '')
    .replace(/\n\s*\n\[[\s\S]*$/, '');
  const shapingCount = (withoutEmbeddedJson.match(/\[SHAPING\]/gi) ?? []).length;
  const normalizedShaping = shapingCount > 1
    ? withoutEmbeddedJson.replace(/(?:\[SHAPING\]\s*)+/i, '[SHAPING] ')
    : withoutEmbeddedJson;

  return normalizedShaping.replace(/\s+/g, ' ').trim();
}

function inferWorkflowKind(description: string, submission: TaskSubmission, options: SubmitTaskOptions): WorkflowKind {
  if (options.workflowKind) return options.workflowKind;
  if (submission.workflowKind) return submission.workflowKind;
  if (description.startsWith('[SHAPING]')) return 'shaping';
  if (/^\s*(full\s+)?review\b/i.test(description) || /\breview\b/i.test(description)) return 'review';
  if (/\b(validate|verification|verify|qa|test review)\b/i.test(description)) return 'validate';
  if (/\b(deploy|ship|release)\b/i.test(description)) return 'ship';
  if (/\b(plan|roadmap|shape)\b/i.test(description)) return 'plan';
  if (/\b(monitor|watch|observe|status)\b/i.test(description)) return 'monitor';
  if (/\b(recover|resume|retry)\b/i.test(description)) return 'recover';
  return 'implement';
}

function enforceInitialWorkflowGuard(
  projectId: string,
  workflowKind: WorkflowKind,
  policy: ReturnType<typeof loadProjectPolicy>,
): void {
  const { initialWorkflowLimit, initialAllowedWorkflows } = policy.launchGuards;
  if (initialWorkflowLimit <= 0 || initialAllowedWorkflows.length === 0) return;

  const autonomy = getProjectAutonomyHealth(projectId);
  if (autonomy.recentCompletedRuns >= initialWorkflowLimit) return;
  if (initialAllowedWorkflows.includes(workflowKind)) return;

  throw new Error(
      `EARLY LAUNCH GUARD: ${projectId} is limited to ${initialAllowedWorkflows.join(', ')} for its first ${initialWorkflowLimit} completed goals. ` +
      `Current workflow "${workflowKind}" is blocked until the early rollout lane stabilizes.`,
    );
}

function inferRequestedActions(description: string): Array<'purchase' | 'contact' | 'create_account'> {
  const matches: Array<'purchase' | 'contact' | 'create_account'> = [];
  if (/\b(purchase|buy|subscribe|pay|charge|invoice|billing)\b/i.test(description)) matches.push('purchase');
  if (/\b(send|email|notify|contact|message|reach out)\b/i.test(description)) matches.push('contact');
  if (/\b(sign up|register|create account)\b/i.test(description)) matches.push('create_account');
  return matches;
}

function resolveBlockedRequestedAction(
  description: string,
  policy: ReturnType<typeof loadProjectPolicy>,
): 'purchase' | 'contact' | 'create_account' | null {
  return inferRequestedActions(description).find((action) => isActionBlocked(policy, action)) ?? null;
}

function resolveGoalDedupeSeed(
  description: string,
  sourceKind: GoalSourceKind,
  workflowKind: WorkflowKind,
  input: Record<string, unknown> | null,
): string {
  if (typeof input?.dedupeKey === 'string' && input.dedupeKey.trim().length > 0) {
    return `${workflowKind}::${sourceKind}::${input.dedupeKey.trim()}`;
  }

  const parts = [description];
  if (sourceKind === 'git_watcher' && typeof input?.commit === 'string') {
    parts.push(`commit:${input.commit}`);
  }
  if (sourceKind === 'monitor' && input?.recovery === true && typeof input?.previousRunId === 'string') {
    parts.push(`recover:${input.previousRunId}`);
  }
  if (sourceKind === 'scheduler' && input?.scheduledReview === true) {
    parts.push(`scheduled:${String(input.projectId ?? '')}`);
  }
  return `${workflowKind}::${sourceKind}::${parts.join('::')}`;
}

// Main entry point: submit a task for processing
export async function submitTask(
  submission: TaskSubmission,
  options: SubmitTaskOptions = {}
): Promise<string> {
  const projectId = options.projectId ?? submission.projectId ?? 'organism';
  const policy = loadProjectPolicy(projectId);
  const description = sanitizeDescription(submission.description);
  const workflowKind = inferWorkflowKind(description, submission, options);
  const sourceKind = options.sourceKind ?? submission.sourceKind ?? 'user';

  enforceInitialWorkflowGuard(projectId, workflowKind, policy);

  const inputRecord = submission.input && typeof submission.input === 'object'
    ? submission.input as Record<string, unknown>
    : null;

  if (workflowKind === 'shaping') {
    const requestedBy = options.agent ?? 'user';
    if (!['user', 'ceo', 'product-manager'].includes(requestedBy)) {
      throw new Error(`Only user, ceo, or product-manager may create shaping workflows. Received: ${requestedBy}`);
    }
    const alreadyShaped = inputRecord?.type === 'shaping_complete' ||
      String(inputRecord?.originalDescription ?? '').startsWith('[SHAPING]') ||
      description.replace(/^\[SHAPING\]\s*/i, '').startsWith('[SHAPING]');
    if (alreadyShaped) {
      throw new Error(`Recursive shaping blocked for "${description.slice(0, 80)}"`);
    }
  }

  // 0. Policy check — sensitive actions stay inside the current autonomy envelope.
  const blockedAction = resolveBlockedRequestedAction(description, policy);
  if (blockedAction) {
    writeAudit({
      agent: options.agent ?? 'orchestrator',
      taskId: 'blocked',
      action: 'gate_eval',
      payload: { type: 'policy_block', description, action: blockedAction, autonomyMode: policy.autonomyMode },
      outcome: 'blocked',
      errorCode: OrganismError.GATE_BLOCKED,
    });
    throw new Error(`POLICY BLOCK: "${description.slice(0, 80)}" — action "${blockedAction}" is blocked in ${policy.autonomyMode} mode for ${projectId}.`);
  }

  // 1. Classify risk
  const classification = await classifyRisk(description, { loc: options.loc });
  const safetyEnvelope = resolveTaskSafetyEnvelope(policy, description, workflowKind);

  if (safetyEnvelope.blockedReason) {
    writeAudit({
      agent: options.agent ?? 'orchestrator',
      taskId: 'blocked',
      action: 'gate_eval',
      payload: {
        type: 'project_safety_block',
        projectId,
        description,
        workflowKind,
        reason: safetyEnvelope.blockedReason,
      },
      outcome: 'blocked',
      errorCode: OrganismError.GATE_BLOCKED,
    });
    throw new Error(safetyEnvelope.blockedReason);
  }

  const effectiveClassification = safetyEnvelope.forcedLane && safetyEnvelope.forcedLane !== classification.lane
    ? {
        ...classification,
        lane: safetyEnvelope.forcedLane,
        reason: `${classification.reason} | Project safety policy forced ${safetyEnvelope.forcedLane}`,
        factors: [...classification.factors, 'project safety policy override'],
      }
    : classification;

  // 2. Resolve owning agent (project-scoped when projectId is set)
  loadRegistry(); // warm cache
  let intendedAgent = options.agent;
  if (!intendedAgent) {
    const resolved = resolveOwner(description, projectId);
    intendedAgent = resolved?.owner ?? 'ceo'; // CEO handles ambiguous and unknown tasks
  }

  const goal = options.goalId
    ? getGoal(options.goalId) ?? ensureGoal({
        projectId,
        title: submission.title ?? description.slice(0, 120),
        description,
        sourceKind,
        workflowKind,
        dedupeSeed: resolveGoalDedupeSeed(description, sourceKind, workflowKind, inputRecord),
      })
    : ensureGoal({
        projectId,
        title: submission.title ?? description.slice(0, 120),
        description,
        sourceKind,
        workflowKind,
        dedupeSeed: resolveGoalDedupeSeed(description, sourceKind, workflowKind, inputRecord),
      });

  // 3. Shape Up gate: MEDIUM/HIGH tasks must reference an approved bet or be rerouted
  const shapingAction = resolveShapingRequirement(effectiveClassification.lane, projectId, options, workflowKind);

  if (shapingAction.type === 'rejected') {
    writeAudit({
      agent: intendedAgent,
      taskId: 'rejected',
      action: 'gate_eval',
      payload: { type: 'shaping_rejected', reason: shapingAction.reason, description },
      outcome: 'blocked',
    });
    throw new Error(`Shape Up gate: ${shapingAction.reason}`);
  }

  if (shapingAction.type === 'convert_to_pitch') {
    // Instead of executing, create a shaping task routed to product-manager.
    // Domain Model is used upstream here for pitch refinement, not as a blanket gate.
    const agent = 'product-manager';
    const task = createTask({
      agent,
      lane: effectiveClassification.lane,
      description: description.startsWith('[SHAPING]') ? description : `[SHAPING] ${description}`,
      input: {
        type: 'pitch_request',
        originalDescription: description,
        originalInput: submission.input,
        intendedAgent,
        requestedLane: classification.lane,
        effectiveLane: effectiveClassification.lane,
        reason: 'No approved bet found for MEDIUM/HIGH task — needs shaping first',
      },
      parentTaskId: options.parentTaskId,
      projectId,
      goalId: goal.id,
      workflowKind: 'shaping',
      sourceKind,
    });

    writeAudit({
      agent,
      taskId: task.id,
      action: 'task_created',
      payload: { classification, description, shapingAction: 'convert_to_pitch', goalId: goal.id },
      outcome: 'success',
    });

    return task.id;
  }

  if (shapingAction.type === 'emergency') {
    writeAudit({
      agent: intendedAgent,
      taskId: 'emergency',
      action: 'gate_eval',
      payload: { type: 'emergency_bypass', reason: shapingAction.reason, description },
      outcome: 'success',
    });
  }

  const resolvedBetId = shapingAction.type === 'proceed' ? shapingAction.betId : undefined;

  // 4. Boundary check if we have a bet
  if (resolvedBetId) {
    const boundaryCheck = checkBetBoundaries(resolvedBetId, description);
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

  // 5. Route to agent — Domain Model is no longer a blanket gate for all MEDIUM/HIGH tasks.
  //    Instead, it is used upstream in pitch refinement (product-manager delegates to domain-model
  //    during shaping). Once a bet is approved, tasks go directly to the intended agent.
  const agent = intendedAgent;
  const taskInput = submission.input && typeof submission.input === 'object'
    ? {
        ...(submission.input as Record<string, unknown>),
        goalId: goal.id,
        workflowKind,
        sourceKind,
      }
    : submission.input;

  // 6. Create task record
  const task = createTask({
    agent,
    lane: effectiveClassification.lane,
    description,
    input: taskInput,
    parentTaskId: options.parentTaskId,
    projectId,
    betId: resolvedBetId,
    goalId: goal.id,
    workflowKind,
    sourceKind,
  });

  writeAudit({
    agent,
    taskId: task.id,
    action: 'task_created',
    payload: {
      classification,
      effectiveClassification,
      description,
      betId: resolvedBetId,
      goalId: goal.id,
      workflowKind,
      sourceKind,
      safeSurfaceMatch: safetyEnvelope.safeSurfaceMatch,
      protectedSurfaceMatch: safetyEnvelope.protectedSurfaceMatch,
    },
    outcome: 'success',
  });

  // 7. Route to pipeline (async — the pipeline runs the actual agent session)
  routeToPipeline(task.id, agent, effectiveClassification.lane, resolvedBetId).catch((err) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const providerFailure = mapProviderFailure(errorMessage);
    const nextStatus = providerFailure.pauseUntilMs ? 'retry_scheduled' : 'paused';
    writeAudit({
      agent,
      taskId: task.id,
      action: 'error',
      payload: {
        message: errorMessage,
        retryClass: providerFailure.retryClass,
        providerFailureKind: providerFailure.providerFailureKind,
      },
      outcome: 'failure',
      errorCode: OrganismError.AGENT_TIMEOUT,
    });
    updateTaskRuntimeState({
      taskId: task.id,
      status: nextStatus,
      error: errorMessage,
      retryClass: providerFailure.retryClass,
      retryAt: providerFailure.pauseUntilMs,
      providerFailureKind: providerFailure.providerFailureKind,
    });
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
 * - Domain Model is no longer in the MEDIUM/HIGH runtime pipeline. It is used upstream
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
      // Removed domain-model from runtime pipeline (now upstream in shaping)
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
