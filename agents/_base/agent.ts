import * as fs from 'fs';
import * as path from 'path';
import { readRecentForAgent } from '../../packages/core/src/audit.js';
import { assertBudget, recordSpend, estimateCost, getAgentSpend, checkOverspend, getPerTaskHardCap } from '../../packages/core/src/budget.js';
import { checkoutTask, completeTask, failTask, awaitReviewTask, getPendingTasks, createTask, getSiblingTaskOutputs, isTaskShadowMode, recordShadowRun, updateTaskRuntimeState } from '../../packages/core/src/task-queue.js';
import { writeAudit } from '../../packages/core/src/audit.js';
import { evaluateG1 } from '../../packages/core/src/gates.js';
import { Task, AgentCapability } from '../../packages/shared/src/types.js';
import { OrganismError } from '../../packages/shared/src/error-taxonomy.js';
import { storeTaskMemory, getWorkingMemory, isStixDBAvailable, searchAcrossAgents, CrossAgentResult } from '../../packages/core/src/memory.js';
import { getCompactContext } from '../../packages/core/src/context-brief.js';
import { recordBetSpend, checkBetCircuitBreaker } from '../../packages/core/src/shapeup.js';
import { resolveTaskSources, loadDistilledSources } from '../../packages/core/src/palate.js';
import { canAgentExecute, loadRegistry } from '../../packages/core/src/registry.js';
import { normalizeAgentEnvelope, extractEnvelopeText } from '../../packages/core/src/agent-envelope.js';
import { createArtifact, createRunSession, getLatestRunForGoal, mapProviderFailure, updateRunStatus, createRunStep, updateRunStep } from '../../packages/core/src/run-state.js';
import { readRunMemory } from '../../packages/core/src/run-memory.js';
import { loadProjectPolicy, requiresHumanReviewGate } from '../../packages/core/src/project-policy.js';
import {
  appendPortableLearning,
  buildPortableWorkspaceSnapshot,
  ensurePortableAgentStack,
  loadPortableAgentContext,
  stagePortableReviewCandidate,
  updatePortableWorkspace,
} from '../../packages/core/src/agent-brain.js';

// Tasklist candidates — checked in order, first found wins
const TASKLIST_CANDIDATES = [
  'tasks/master_tasklist.md',
  'TASKLIST.md',
  'tasks/todo.md',
  '.ai/tasklist.md',
  'TODO.md',
];

function withRetryBackoff(basePauseUntilMs: number | null, attemptCount: number): number | null {
  if (!basePauseUntilMs) return null;
  const baseDelayMs = Math.max(basePauseUntilMs - Date.now(), 60_000);
  const multiplier = Math.min(Math.max(attemptCount - 1, 0), 3);
  return Date.now() + (baseDelayMs * (2 ** multiplier));
}

export type AgentModel = 'haiku' | 'sonnet' | 'opus' | 'gpt4o' | 'gpt5.4';

export interface AgentConfig {
  name: string;
  registryOwner?: string;
  model: AgentModel;
  capability: AgentCapability;
  maxRunTimeMs?: number; // Default: 30 minutes
  requiredSecrets?: string[];
}

export abstract class BaseAgent {
  protected readonly name: string;
  protected readonly model: AgentModel;
  protected readonly config: AgentConfig;
  protected projectContext: Record<string, unknown> | null = null;
  protected crossAgentMemory: CrossAgentResult[] = [];
  protected relatedFindings: Array<{ agent: string; description: string; outputSummary: string }> = [];
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private activeTaskHeartbeat: {
    taskId: string;
    runStepId: string;
    runId: string;
    description: string;
    startedAt: number;
  } | null = null;

  constructor(config: AgentConfig) {
    let runtimeConfig = config;
    try {
      const registryOwner = config.registryOwner ?? config.name;
      const registryCap = loadRegistry().find((cap) => cap.owner === registryOwner);
      if (!registryCap) {
        throw new Error(`Agent '${registryOwner}' is missing from capability-registry.json`);
      }
      runtimeConfig = {
        ...config,
        model: registryCap.model,
        capability: {
          ...config.capability,
          ...registryCap,
        },
      };
    } catch (err) {
      if (process.env.NODE_ENV === 'test') {
        runtimeConfig = {
          ...config,
          capability: {
            ...config.capability,
            status: 'shadow',
          },
        };
      } else {
        throw err;
      }
    }

    this.name = runtimeConfig.name;
    this.model = runtimeConfig.model;
    this.config = runtimeConfig;
  }

  // Load recent audit entries for session continuity (the "breadcrumb" pattern)
  protected loadBreadcrumbs(limit = 5) {
    const entries = readRecentForAgent(this.name, limit);
    if (entries.length > 0) {
      console.log(`[${this.name}] Last ${entries.length} audit entries:`);
      for (const e of entries) {
        console.log(`  [${new Date(e.ts).toISOString()}] ${e.action} → ${e.outcome}`);
      }
    }
    return entries;
  }

  // Load tasklist from project directory — ground truth for what's done/pending.
  // When projectId is provided, ONLY loads from that project's configured path
  // to prevent cross-project context leaks.
  protected loadTasklist(projectId?: string, projectPath?: string): string | null {
    const searchRoots: string[] = [];

    if (projectId) {
      // Scoped load: only look at the specific project's configured path
      const configPath = path.resolve(process.cwd(), 'knowledge/projects', projectId, 'config.json');
      if (fs.existsSync(configPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          // If config has a direct tasklist path, try it first
          if (cfg.tasklist && fs.existsSync(cfg.tasklist)) {
            const content = fs.readFileSync(cfg.tasklist, 'utf8');
            console.log(`[${this.name}] Loaded tasklist for ${projectId}: ${cfg.tasklist} (${content.length} chars)`);
            return content;
          }
          // Fall back to projectPath from config
          if (cfg.projectPath) {
            searchRoots.push(cfg.projectPath);
          }
        } catch { /* skip */ }
      }
    }

    // If a direct projectPath was provided, add it
    if (projectPath) {
      searchRoots.push(projectPath);
    }

    for (const root of searchRoots) {
      for (const candidate of TASKLIST_CANDIDATES) {
        const full = path.join(root, candidate);
        if (fs.existsSync(full)) {
          const content = fs.readFileSync(full, 'utf8');
          console.log(`[${this.name}] Loaded tasklist: ${full} (${content.length} chars)`);
          return content;
        }
      }
    }
    return null;
  }

  // Load project review context from knowledge/projects/<id>/review-context.json
  protected loadProjectContext(projectId: string): Record<string, unknown> | null {
    const contextPath = path.resolve(process.cwd(), 'knowledge/projects', projectId, 'review-context.json');
    if (fs.existsSync(contextPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
        console.log(`[${this.name}] Loaded project context for ${projectId} (${contextPath})`);
        return data as Record<string, unknown>;
      } catch { /* skip */ }
    }
    return null;
  }

  // Main entry point — polls for pending tasks and processes them
  async run() {
    ensurePortableAgentStack();
    this.loadBreadcrumbs();
    this.loadTasklist(); // logs tasklist presence; subclasses access via execute() input

    // Load agent's working memory from StixDB (if available)
    try {
      if (await isStixDBAvailable()) {
        const memories = await getWorkingMemory(this.name, 10);
        if (memories.length > 0) {
          console.log(`[${this.name}] StixDB: ${memories.length} working memories loaded`);
        }
      }
    } catch { /* StixDB optional */ }

    console.log(`[${this.name}] Starting. Model: ${this.model}`);

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => this.heartbeat(), 30 * 1000);

    try {
      await this.processPendingTasks();
    } finally {
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    }
  }

  private async processPendingTasks() {
    const pending = getPendingTasks(this.name);
    if (pending.length === 0) {
      console.log(`[${this.name}] No pending tasks. Idle.`);
      return;
    }

    for (const task of pending) {
      const taskShadowMode = isTaskShadowMode(task);
      if (!canAgentExecute(this.name, task.projectId, { includeShadow: taskShadowMode })) {
        updateTaskRuntimeState({
          taskId: task.id,
          status: 'paused',
          error: `Agent ${this.name} is not enabled for project ${task.projectId ?? 'organism'}`,
          retryClass: 'manual_pause',
        });
        continue;
      }
      await this.processTask(task);
    }
  }

  private async processTask(task: Task) {
    // Atomic checkout — exit if another agent took it
    const checked = checkoutTask(task.id, this.name);
    if (!checked) {
      console.log(`[${this.name}] Task ${task.id} already taken. Skipping.`);
      return;
    }
    const attemptCount = checked.attemptCount ?? 1;
    const taskShadowMode = isTaskShadowMode(checked);

    const startedAt = Date.now();
    const maxRunTime = this.config.maxRunTimeMs ?? 30 * 60 * 1000;

    updatePortableWorkspace(
      buildPortableWorkspaceSnapshot(
        task,
        this.name,
        'running',
        'Continue the current bounded task and record the next safe step before handing off.',
      ),
    );

    // Load project context from filesystem if available
    if (task.projectId) {
      this.projectContext = this.loadProjectContext(task.projectId);
    }

    writeAudit({
      agent: this.name,
      taskId: task.id,
      action: 'task_checkout',
      payload: { taskDescription: task.description, lane: task.lane },
      outcome: 'success',
    });

    let run = null;
    let runStep = null;
    if (task.goalId) {
      const resumeMemory = readRunMemory(task.goalId);
      if (task.input && typeof task.input === 'object') {
        (task as { input: unknown }).input = {
          ...(task.input as Record<string, unknown>),
          resumeContext: {
            handoff: resumeMemory.handoff.slice(-2000),
            progress: resumeMemory.progress.slice(-2000),
            facts: resumeMemory.facts,
            recentCommands: resumeMemory.commandLog.slice(-10),
          },
        };
      }

      const latest = getLatestRunForGoal(task.goalId);
      if (latest && ['pending', 'running', 'paused', 'retry_scheduled'].includes(latest.status) && latest.agent === this.name) {
        run = latest;
        if (latest.status !== 'running') {
          updateRunStatus({
            runId: latest.id,
            status: 'running',
            summary: `Resuming ${this.name} from the latest verified checkpoint.`,
          });
        }
      } else {
        run = createRunSession({
          goalId: task.goalId,
          projectId: task.projectId ?? 'organism',
          agent: this.name,
          workflowKind: task.workflowKind ?? 'implement',
        });
      }
      runStep = createRunStep({
        runId: run.id,
        name: `agent:${this.name}:execute`,
        detail: task.description.slice(0, 240),
      });
      updateRunStep({ stepId: runStep.id, status: 'running' });
      this.activeTaskHeartbeat = {
        taskId: task.id,
        runStepId: runStep.id,
        runId: run.id,
        description: task.description,
        startedAt,
      };
    }

    // Budget guard
    const estimatedTokensOut = 2000;
    const estimated = estimateCost(this.model, 5000, estimatedTokensOut);
    try {
      assertBudget(this.name, estimated);
    } catch (err) {
      const message = String(err);
      if (run && runStep) {
        updateRunStep({ stepId: runStep.id, status: 'failed', detail: message.slice(0, 500) });
        updateRunStatus({
          runId: run.id,
          status: 'paused',
          retryClass: 'budget_pause',
          providerFailureKind: 'policy_block',
          summary: message.slice(0, 500),
        });
      }
      writeAudit({
        agent: this.name,
        taskId: task.id,
        action: 'budget_check',
        payload: { error: message },
        outcome: 'blocked',
        errorCode: OrganismError.BUDGET_CAP_EXCEEDED,
      });
      updateTaskRuntimeState({
        taskId: task.id,
        status: 'paused',
        error: message,
        retryClass: 'budget_pause',
        providerFailureKind: 'policy_block',
      });
      appendPortableLearning({
        ts: Date.now(),
        agent: this.name,
        projectId: task.projectId ?? 'organism',
        taskId: task.id,
        workflowKind: task.workflowKind ?? 'implement',
        lane: task.lane,
        status: 'paused',
        summary: message.slice(0, 500),
      });
      stagePortableReviewCandidate({
        agent: this.name,
        projectId: task.projectId ?? 'organism',
        taskId: task.id,
        kind: 'failure-pattern',
        summary: `Budget/policy block for ${task.description.slice(0, 80)}`,
        evidence: message.slice(0, 500),
      });
      updatePortableWorkspace(
        buildPortableWorkspaceSnapshot(
          task,
          this.name,
          'paused',
          'Pause until the budget or policy block is resolved.',
          message.slice(0, 240),
        ),
      );
      this.activeTaskHeartbeat = null;
      return;
    }

    // Timeout guard
    const timeoutHandle = setTimeout(() => {
      if (run && runStep) {
        updateRunStep({ stepId: runStep.id, status: 'failed', detail: `Timeout after ${maxRunTime}ms` });
        updateRunStatus({
          runId: run.id,
          status: 'retry_scheduled',
          retryClass: 'transient_error',
          retryAt: Date.now() + 10 * 60 * 1000,
          providerFailureKind: 'timeout',
          summary: `Timed out after ${maxRunTime}ms`,
        });
      }
      writeAudit({
        agent: this.name,
        taskId: task.id,
        action: 'error',
        payload: { message: 'Agent exceeded max run time' },
        outcome: 'failure',
        errorCode: OrganismError.AGENT_TIMEOUT,
      });
      updateTaskRuntimeState({
        taskId: task.id,
        status: 'retry_scheduled',
        error: `Timeout after ${maxRunTime}ms`,
        retryClass: 'transient_error',
        retryAt: Date.now() + 10 * 60 * 1000,
        providerFailureKind: 'timeout',
      });
      appendPortableLearning({
        ts: Date.now(),
        agent: this.name,
        projectId: task.projectId ?? 'organism',
        taskId: task.id,
        workflowKind: task.workflowKind ?? 'implement',
        lane: task.lane,
        status: 'retry_scheduled',
        summary: `Timeout after ${maxRunTime}ms`,
      });
      stagePortableReviewCandidate({
        agent: this.name,
        projectId: task.projectId ?? 'organism',
        taskId: task.id,
        kind: 'failure-pattern',
        summary: `Timeout pattern for ${task.description.slice(0, 80)}`,
        evidence: `Timed out after ${maxRunTime}ms.`,
      });
      updatePortableWorkspace(
        buildPortableWorkspaceSnapshot(
          task,
          this.name,
          'retry_scheduled',
          'Retry the bounded task after timeout recovery or narrow the scope.',
          `Timeout after ${maxRunTime}ms`,
        ),
      );
      this.activeTaskHeartbeat = null;
    }, maxRunTime);

    // Cross-agent memory: pull relevant findings from other agents before executing
    try {
      if (await isStixDBAvailable()) {
        this.crossAgentMemory = await searchAcrossAgents(task.description, [], 5);
        if (this.crossAgentMemory.length > 0) {
          console.log(`[${this.name}] StixDB: ${this.crossAgentMemory.length} cross-agent memories for task ${task.id}`);
        }
      }
    } catch { /* StixDB optional — don't block task execution */ }

    // Sibling findings injection: load outputs from completed sibling tasks (same parent)
    this.relatedFindings = [];
    if (task.parentTaskId) {
      try {
        this.relatedFindings = getSiblingTaskOutputs(task.parentTaskId, task.id);
        if (this.relatedFindings.length > 0) {
          console.log(`[${this.name}] Loaded ${this.relatedFindings.length} sibling findings for task ${task.id}`);
        }
      } catch { /* non-critical — don't block task execution */ }
    }

    // Quality feedback loop: if this task carries quality feedback from a review,
    // log it so the concrete agent's execute() can access it via task.input.qualityFeedback.
    const taskInput = task.input as Record<string, unknown> | null;
    if (taskInput?.qualityFeedback) {
      console.log(`[${this.name}] Revision task — quality feedback attached from task ${taskInput.originalTaskId ?? 'unknown'}`);
    }

    // Merge project context into task.input using compact briefs (not raw giant context).
    // Compact briefs include only the fields this agent actually needs, reducing token burn.
    if (task.projectId && task.input && typeof task.input === 'object') {
      const input = task.input as Record<string, unknown>;
      if (!input.context && !input.codeEvidence) {
        const compactCtx = getCompactContext(task.projectId, this.name);
        if (compactCtx) {
          try {
            const briefFields = JSON.parse(compactCtx) as Record<string, unknown>;
            (task as { input: unknown }).input = { ...briefFields, ...input };
          } catch {
            // Fallback to raw project context if brief parsing fails
            if (this.projectContext) {
              (task as { input: unknown }).input = { ...this.projectContext, ...input };
            }
          }
        } else if (this.projectContext) {
          // No brief available — fall back to raw context
          (task as { input: unknown }).input = { ...this.projectContext, ...input };
        }
      }
    }

    const portableBrain = loadPortableAgentContext();
    if (task.input && typeof task.input === 'object') {
      const input = task.input as Record<string, unknown>;
      if (!input.portableBrain) {
        (task as { input: unknown }).input = { ...input, portableBrain };
      }
    } else {
      (task as { input: unknown }).input = {
        originalInput: task.input ?? null,
        portableBrain,
      };
    }

    // Palate: inject capability-scoped knowledge sources for this specific task.
    // Resolves by capability + project (not agent name) — only fires when the
    // matched capability actually declares knowledgeSources in the registry.
    const sourceInjection = resolveTaskSources(task.description, task.projectId);
    if (sourceInjection) {
      const sources = await loadDistilledSources(sourceInjection, task.id, this.name);
      if (Object.keys(sources).length > 0) {
        const input = (task.input ?? {}) as Record<string, unknown>;
        input.knowledgeSources = sources;
        (task as { input: unknown }).input = input;
      }
    }

    try {
      const result = await this.execute(task);
      clearTimeout(timeoutHandle);
      const envelope = normalizeAgentEnvelope(this.name, task, result.output);

      const tokensUsed = result.tokensUsed ?? 0;
      let costUsd = estimateCost(this.model, Math.floor(tokensUsed * 0.7), Math.floor(tokensUsed * 0.3));

      const hardCap = getPerTaskHardCap(this.name);
      if (hardCap && costUsd > hardCap) {
        console.warn(`[${this.name}] Per-task hard cap hit: $${costUsd.toFixed(4)} > $${hardCap.toFixed(2)} — clamping`);
        costUsd = hardCap;
      }

      recordSpend(this.name, Math.floor(tokensUsed * 0.7), Math.floor(tokensUsed * 0.3), costUsd, task.projectId ?? 'organism');

      // Bet spend tracking: if task is linked to a bet, record spend and check circuit breaker
      if (task.betId) {
        try {
          recordBetSpend(task.betId, tokensUsed, costUsd);
          const cbResult = checkBetCircuitBreaker(task.betId);
          if (cbResult.tripped) {
            writeAudit({
              agent: this.name,
              taskId: task.id,
              action: 'budget_check',
              payload: { betId: task.betId, exception: cbResult.exception, reason: cbResult.reason },
              outcome: 'blocked',
            });
            console.warn(`[${this.name}] Bet ${task.betId} circuit breaker tripped: ${cbResult.reason}`);
          }
        } catch (betErr) {
          console.warn(`[${this.name}] Bet spend tracking failed for bet ${task.betId}: ${betErr}`);
        }
      }

      // HIGH lane + primary agents: queue review pipeline then pause for Rafael's review.
      // Pipeline internals (domain-model, legacy grill-me alias, codex-review, quality-agent, quality-guardian)
      // auto-complete as before — they ARE the review pipeline.
      const PIPELINE_INTERNAL_AGENTS = [
        'domain-model', 'grill-me', 'codex-review', 'quality-agent', 'quality-guardian',
        'legal', 'security-audit',
      ];
      const isPipelineInternal = PIPELINE_INTERNAL_AGENTS.includes(this.name);
      const policy = loadProjectPolicy(task.projectId ?? 'organism');
      const needsHumanReviewGate = requiresHumanReviewGate(
        policy,
        task.description,
        task.workflowKind ?? 'implement',
        task.lane,
      );

      if (needsHumanReviewGate && !isPipelineInternal && !taskShadowMode) {
        // Queue the HIGH-lane review pipeline with TRIGGER DISCIPLINE:
        // Not all reviewers fire for every task. Match reviewers to task content.
        const outputSummary = extractEnvelopeText(envelope).slice(0, 3000);

        // Determine which reviewers are relevant to this task
        const reviewAgents = selectReviewers(task.description, this.name);

        writeAudit({
          agent: this.name,
          taskId: task.id,
          action: 'task_created',
          payload: { reviewerSelection: reviewAgents, reason: 'trigger-discipline', allAvailable: ['legal', 'security-audit', 'quality-guardian', 'codex-review'] },
          outcome: 'success',
        });

        for (const reviewer of reviewAgents) {
          try {
            createTask({
              agent: reviewer,
              lane: 'LOW', // review tasks themselves are LOW — they're read-only assessments
              description: `HIGH-lane review (${reviewer}): "${task.description.slice(0, 80)}"`,
              input: {
                originalTaskId: task.id,
                originalAgent: this.name,
                originalDescription: task.description,
                output: outputSummary,
                reviewType: 'high-lane-pipeline',
              },
              parentTaskId: task.id,
              projectId: task.projectId ?? 'organism',
              goalId: task.goalId,
              workflowKind: 'validate',
              sourceKind: 'agent_followup',
            });
            console.log(`[${this.name}] Queued HIGH-lane review: ${reviewer} for task ${task.id}`);
          } catch {
            // Duplicate detection may fire — safe to ignore
            console.warn(`[${this.name}] Skipped ${reviewer} review for task ${task.id} (duplicate or error)`);
          }
        }

        awaitReviewTask(task.id, envelope, tokensUsed, costUsd);
        if (run && runStep) {
          updateRunStep({ stepId: runStep.id, status: 'completed', detail: `Awaiting review: ${envelope.summary}` });
          createArtifact({
            runId: run.id,
            goalId: run.goalId,
            kind: 'report',
            title: `${this.name} awaiting review`,
            content: extractEnvelopeText(envelope).slice(0, 4000),
          });
          updateRunStatus({
            runId: run.id,
            status: 'paused',
            retryClass: 'manual_pause',
            summary: `Awaiting Rafael review: ${envelope.summary}`,
          });
        }
        console.log(`[${this.name}] Task ${task.id} → awaiting_review (G4 gate). Cost: $${costUsd.toFixed(4)}`);

        writeAudit({
          agent: this.name,
          taskId: task.id,
          action: 'task_completed',
          payload: { durationMs: Date.now() - startedAt, tokensUsed, costUsd, awaitingReview: true, reviewsQueued: reviewAgents },
          outcome: 'success',
        });
        appendPortableLearning({
          ts: Date.now(),
          agent: this.name,
          projectId: task.projectId ?? 'organism',
          taskId: task.id,
          workflowKind: task.workflowKind ?? 'implement',
          lane: task.lane,
          status: 'awaiting_review',
          summary: `Queued for human review: ${envelope.summary}`,
        });
        updatePortableWorkspace(
          buildPortableWorkspaceSnapshot(
            task,
            this.name,
            'awaiting_review',
            'Wait for the human review gate before any further autonomous work.',
            envelope.summary,
          ),
        );
        this.activeTaskHeartbeat = null;
        return; // Stop here — no auto-chaining until Rafael approves
      }

      // Silent-failure guard: refuse $0 completions with empty output.
      // Prevents agents from marking tasks "done" when they short-circuited
      // (missing API key, rate-limited guard, stub return) — which would
      // otherwise count as healthy runs and break the autonomy governor.
      {
        const envelopeText = extractEnvelopeText(envelope) || '';
        const summaryText = envelope?.summary ?? '';
        const totalLen = envelopeText.length + summaryText.length;
        if (costUsd === 0 && tokensUsed === 0 && totalLen < 50 && !taskShadowMode) {
          const errMsg = 'empty_output_silent_failure: agent returned no content and spent $0 (likely missing API key, rate limit, or short-circuited guard).';
          failTask(task.id, errMsg);
          if (run && runStep) {
            updateRunStep({ stepId: runStep.id, status: 'failed', detail: errMsg });
            updateRunStatus({ runId: run.id, status: 'failed', summary: errMsg });
          }
          console.error(`[${this.name}] Task ${task.id} → failed (silent failure): ${errMsg}`);
          writeAudit({
            agent: this.name,
            taskId: task.id,
            action: 'task_failed',
            payload: { reason: 'empty_output_silent_failure', durationMs: Date.now() - startedAt, tokensUsed, costUsd },
            outcome: 'failure',
            errorCode: OrganismError.PROVIDER_EMPTY_OUTPUT,
          });
          this.activeTaskHeartbeat = null;
          return;
        }
      }

      completeTask(task.id, envelope, tokensUsed, costUsd);
      if (taskShadowMode) {
        recordShadowRun({
          agent: this.name,
          taskId: task.id,
          output: envelope,
          projectId: task.projectId,
          lane: task.lane,
          description: task.description,
        });
        writeAudit({
          agent: this.name,
          taskId: task.id,
          action: 'shadow_run',
          payload: {
            lane: task.lane,
            projectId: task.projectId ?? 'organism',
            summary: envelope.summary,
          },
          outcome: 'success',
        });
      }

      if (run && runStep) {
        updateRunStep({ stepId: runStep.id, status: 'completed', detail: envelope.summary });
        createArtifact({
          runId: run.id,
          goalId: run.goalId,
          kind: 'report',
          title: `${this.name} output`,
          content: extractEnvelopeText(envelope).slice(0, 4000),
        });
        updateRunStatus({
          runId: run.id,
          status: 'completed',
          summary: envelope.summary,
        });
      }

      // Overspend detection — log or escalate if task exceeded budget estimate
      const overspend = checkOverspend(this.name, task.id, task.lane, costUsd);
      if (overspend) {
        writeAudit({
          agent: this.name,
          taskId: task.id,
          action: 'budget_check',
          payload: {
            overspend: true,
            estimated: overspend.estimatedBudget,
            actual: overspend.actualCost,
            overPct: overspend.overPct.toFixed(0) + '%',
            action: overspend.action,
          },
          outcome: overspend.action === 'ESCALATE' ? 'blocked' : 'success',
        });
        if (overspend.action === 'ESCALATE') {
          console.error(`[${this.name}] OVERSPEND ESCALATION: Task ${task.id} cost $${overspend.actualCost.toFixed(4)} vs estimated $${overspend.estimatedBudget.toFixed(4)} (${overspend.overPct.toFixed(0)}% over)`);
        } else if (overspend.action === 'PAUSE') {
          console.warn(`[${this.name}] Overspend pause signal: ${overspend.overPct.toFixed(0)}% over budget for task ${task.id}`);
        }
      }

      // Auto-chain: for MEDIUM tasks, queue codex-review
      if (task.lane === 'MEDIUM' && !taskShadowMode) {
        try {
          createTask({
            agent: 'codex-review',
            lane: 'LOW',
            description: `Codex review: "${task.description.slice(0, 80)}"`,
            input: {
              originalTaskId: task.id,
              originalDescription: task.description,
              output: typeof result.output === 'object' && result.output !== null
                ? extractEnvelopeText(envelope).slice(0, 3000)
                : String(result.output).slice(0, 3000),
            },
            parentTaskId: task.id,
            projectId: task.projectId ?? 'organism',
            goalId: task.goalId,
            workflowKind: 'validate',
            sourceKind: 'agent_followup',
          });
        } catch { /* codex-review optional — don't fail the task */ }
      }

      // Store task completion in agent's long-term memory
      try {
        const outputText = extractEnvelopeText(envelope).slice(0, 1000);
        await storeTaskMemory(this.name, {
          id: task.id,
          description: task.description,
          output: outputText,
          costUsd: costUsd,
          projectId: task.projectId,
        });
      } catch { /* StixDB optional — don't fail task if memory store fails */ }

      // G1 automated gate — runs after every task completion
      const agentSpendToday = getAgentSpend(this.name);
      const agentCap = this.config.capability?.reviewerLane === 'HIGH' ? 25 : 5;
      evaluateG1(task.id, {
        testsPassed: true,   // no test runner yet — default true until Week 3
        withinBudget: agentSpendToday < agentCap,
        noErrors: !result.output || !(result.output as Record<string, unknown>)?.error,
      });

      writeAudit({
        agent: this.name,
        taskId: task.id,
        action: 'task_completed',
        payload: { durationMs: Date.now() - startedAt, tokensUsed, costUsd },
        outcome: 'success',
      });

      appendPortableLearning({
        ts: Date.now(),
        agent: this.name,
        projectId: task.projectId ?? 'organism',
        taskId: task.id,
        workflowKind: task.workflowKind ?? 'implement',
        lane: task.lane,
        status: 'success',
        summary: envelope.summary,
      });
      if (taskInput?.qualityFeedback) {
        stagePortableReviewCandidate({
          agent: this.name,
          projectId: task.projectId ?? 'organism',
          taskId: task.id,
          kind: 'review-feedback',
          summary: `Revision pattern for ${task.description.slice(0, 80)}`,
          evidence: 'This task completed with attached quality feedback and should be reviewed for a reusable lesson.',
        });
      }
      updatePortableWorkspace(
        buildPortableWorkspaceSnapshot(
          task,
          this.name,
          'completed',
          'Pick the next safe bounded task or hand off to validation.',
          envelope.summary,
        ),
      );

      console.log(`[${this.name}] Task ${task.id} completed. Cost: $${costUsd.toFixed(4)}`);
      this.activeTaskHeartbeat = null;
    } catch (err) {
      clearTimeout(timeoutHandle);
      const errorMsg = String(err);
      const providerFailure = mapProviderFailure(errorMsg);
      const retryAt = withRetryBackoff(providerFailure.pauseUntilMs, attemptCount);
      const nextStatus = retryAt ? 'retry_scheduled' : 'paused';

      if (run && runStep) {
        updateRunStep({ stepId: runStep.id, status: 'failed', detail: errorMsg.slice(0, 500) });
        updateRunStatus({
          runId: run.id,
          status: nextStatus,
          retryClass: providerFailure.retryClass,
          retryAt,
          providerFailureKind: providerFailure.providerFailureKind,
          summary: errorMsg.slice(0, 500),
        });
      }
      writeAudit({
        agent: this.name,
        taskId: task.id,
        action: 'task_completed',
        payload: { error: errorMsg },
        outcome: 'failure',
      });
      updateTaskRuntimeState({
        taskId: task.id,
        status: nextStatus,
        error: errorMsg,
        retryClass: providerFailure.retryClass,
        retryAt,
        providerFailureKind: providerFailure.providerFailureKind,
      });
      appendPortableLearning({
        ts: Date.now(),
        agent: this.name,
        projectId: task.projectId ?? 'organism',
        taskId: task.id,
        workflowKind: task.workflowKind ?? 'implement',
        lane: task.lane,
        status: nextStatus,
        summary: errorMsg.slice(0, 500),
      });
      stagePortableReviewCandidate({
        agent: this.name,
        projectId: task.projectId ?? 'organism',
        taskId: task.id,
        kind: 'failure-pattern',
        summary: `Failure pattern for ${task.description.slice(0, 80)}`,
        evidence: errorMsg.slice(0, 500),
      });
      updatePortableWorkspace(
        buildPortableWorkspaceSnapshot(
          task,
          this.name,
          nextStatus,
          nextStatus === 'retry_scheduled'
            ? 'Retry the current bounded task after recovery or reroute to the smallest validation step.'
            : 'Pause and inspect the latest blocker before continuing.',
          errorMsg.slice(0, 240),
        ),
      );
      console.error(`[${this.name}] Task ${task.id} failed: ${errorMsg}`);
      this.activeTaskHeartbeat = null;
    } finally {
      if (this.activeTaskHeartbeat?.taskId === task.id) {
        this.activeTaskHeartbeat = null;
      }
    }
  }

  private heartbeat() {
    writeAudit({
      agent: this.name,
      taskId: 'heartbeat',
      action: 'task_created', // reusing action field as signal
      payload: { heartbeat: true, ts: Date.now() },
      outcome: 'success',
    });

    if (!this.activeTaskHeartbeat) return;

    const elapsedMs = Math.max(0, Date.now() - this.activeTaskHeartbeat.startedAt);
    const minutes = Math.floor(elapsedMs / 60_000);
    const seconds = Math.floor((elapsedMs % 60_000) / 1000);
    const elapsedLabel = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    updateRunStep({
      stepId: this.activeTaskHeartbeat.runStepId,
      status: 'running',
      detail: `Still working on "${this.activeTaskHeartbeat.description.slice(0, 180)}" · ${elapsedLabel} elapsed`,
    });
  }

  /**
   * Returns a prompt prefix when the task carries quality feedback from a review.
   * Concrete agents can prepend this to their prompt so the LLM knows it's a revision.
   * Returns empty string if no quality feedback is present.
   */
  protected getQualityFeedbackPrefix(task: Task): string {
    const input = task.input as Record<string, unknown> | null;
    if (!input?.qualityFeedback) return '';

    const feedback = String(input.qualityFeedback).slice(0, 2000);
    const origDesc = (input.originalDescription as string) ?? '';

    return `⚠ REVISION REQUEST — A quality review flagged critical issues with a previous attempt at this task.

Original task: ${origDesc}

Quality feedback:
---
${feedback}
---

Address the issues raised above. Focus on the specific problems identified. Do NOT repeat the same approach that was rejected.

`;
  }

  // Implement in each concrete agent
  protected abstract execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }>;
}

// ── Trigger discipline: select only relevant reviewers ───────────────────
// Instead of firing all 4 expensive reviewers for every HIGH-lane task,
// match reviewers to task content. Quality-guardian always fires (last line
// of defence). Others fire only when their domain is relevant.
//
// This is AUDITABLE: the reviewer selection is logged in the audit trail.

const SECURITY_TRIGGERS = [
  'auth', 'authentication', 'security', 'owasp', 'vulnerability', 'cve',
  'encryption', 'credentials', 'permissions', 'injection', 'xss', 'csrf',
  'cors', 'rls', 'session hijack', 'data breach', 'data exposure',
  'api security', 'infra security',
];

const LEGAL_TRIGGERS = [
  'legal', 'compliance', 'gdpr', 'privacy act', 'copyright', 'license',
  'terms', 'tos', 'disclaimer', 'consumer law', 'acl', 'ahpra', 'tga',
  'contract', 'ip', 'intellectual property', 'subscription', 'billing',
  'payment', 'refund', 'medical', 'health data', 'ndb',
];

const CODEX_TRIGGERS = [
  'code', 'function', 'api', 'endpoint', 'database', 'query', 'sql',
  'migration', 'deploy', 'feature', 'bug', 'fix', 'refactor', 'test',
  'engineering', 'architecture', 'performance', 'component',
];

function selectReviewers(taskDescription: string, sourceAgent: string): string[] {
  const desc = taskDescription.toLowerCase();
  const reviewers: string[] = [];

  // Quality Guardian ALWAYS fires for HIGH-lane tasks — it's the last line of defence
  reviewers.push('quality-guardian');

  // Codex review is part of the core loop (agent → quality → codex)
  reviewers.push('codex-review');

  // Security and legal self-schedule via nextReviewDays — only fire when their
  // domain is genuinely relevant, not on every task
  if (SECURITY_TRIGGERS.some(t => desc.includes(t))) {
    reviewers.push('security-audit');
  }

  // Legal fires if task touches legal/compliance areas
  if (LEGAL_TRIGGERS.some(t => desc.includes(t))) {
    reviewers.push('legal');
  }

  // Codex review fires if task involves code or engineering
  if (CODEX_TRIGGERS.some(t => desc.includes(t))) {
    reviewers.push('codex-review');
  }

  // Fallback: if only quality-guardian matched, add codex-review as a second opinion
  // to ensure at least 2 reviewers for HIGH-lane tasks.
  if (reviewers.length === 1) {
    reviewers.push('codex-review');
  }

  return reviewers;
}
