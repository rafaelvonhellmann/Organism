import { classifyRisk } from './risk-classifier.js';
import { createTask, checkoutTask, completeTask, failTask, reapDeadLetters, getPendingTasks, getDeadLetterTasks } from './task-queue.js';
import { assertBudget, recordSpend, getSpendSummary } from './budget.js';
import { writeAudit } from './audit.js';
import { loadRegistry, resolveOwner } from './registry.js';
import { RiskLane } from '../../shared/src/types.js';
import { OrganismError } from '../../shared/src/error-taxonomy.js';

// Orchestrator is the single main loop. Agents submit tasks here.
// Paperclip is the ONLY orchestrator — PraisonAI is a tool provider only.

export interface SubmitTaskOptions {
  agent?: string;        // Override resolved agent (for explicit delegation)
  parentTaskId?: string;
  loc?: number;          // Lines of code changed (for risk classification)
  projectId?: string;    // Project this task belongs to (default: 'organism')
}

export interface TaskSubmission {
  description: string;
  input: unknown;
  projectId?: string;    // Can also be set here; options.projectId takes precedence
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

  // 3. Route MEDIUM and HIGH tasks through Grill-Me first.
  //    Grill-Me interrogates, then creates the real task for intendedAgent.
  //    LOW tasks go directly to the intended agent.
  let agent: string;
  let taskInput: unknown;

  if (classification.lane === 'LOW' || intendedAgent === 'grill-me') {
    agent = intendedAgent;
    taskInput = submission.input;
  } else {
    // MEDIUM / HIGH: Grill-Me runs first
    agent = 'grill-me';
    taskInput = {
      intendedAgent,
      originalDescription: submission.description,
      originalInput: submission.input,
    };
  }

  // 4. Create task record
  const task = createTask({
    agent,
    lane: classification.lane,
    description: submission.description,
    input: taskInput,
    parentTaskId: options.parentTaskId,
    projectId,
  });

  writeAudit({
    agent,
    taskId: task.id,
    action: 'task_created',
    payload: { classification, description: submission.description },
    outcome: 'success',
  });

  // 4. Route to pipeline (async — the pipeline runs the actual agent session)
  routeToPipeline(task.id, agent, classification.lane).catch((err) => {
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

// Pipeline routing based on risk lane
async function routeToPipeline(taskId: string, agent: string, lane: RiskLane): Promise<void> {
  // Pre-flight budget check — estimates from observed costs (v2 review: ~$0.04-0.08/task)
  const estimatedCost = lane === 'HIGH' ? 0.30 : lane === 'MEDIUM' ? 0.10 : 0.05;
  assertBudget(agent, estimatedCost);

  writeAudit({
    agent,
    taskId,
    action: 'task_checkout',
    payload: { lane, pipeline: getPipelineStages(lane) },
    outcome: 'success',
  });

  // Actual pipeline execution is handled by the agent runner (agents/_base/agent.ts)
  // The orchestrator just records routing; the agent process picks up pending tasks.
  console.log(`[Orchestrator] Task ${taskId} → ${lane} lane → agent: ${agent}`);
}

function getPipelineStages(lane: RiskLane): string[] {
  switch (lane) {
    case 'LOW':
      return ['quality-agent', 'auto-ship'];
    case 'MEDIUM':
      return ['grill-me', 'quality-agent', 'codex-review', 'auto-ship'];
    case 'HIGH':
      return ['grill-me', 'quality-agent', 'copyright', 'legal', 'security', 'quality-guardian', 'codex-review', 'G4-gate'];
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
