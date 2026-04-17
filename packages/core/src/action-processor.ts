import { getDb } from './task-queue.js';
import { captureProjectLaunchBaseline } from './launch-baseline.js';
import { captureProjectMemorySnapshot } from './project-memory.js';
import { decideProjectStart } from './start-continue.js';
import { WorkflowKind } from '../../shared/src/types.js';

interface DashboardAction {
  id: number;
  action: string;
  payload: string | null;
  status: string;
  result?: string | null;
  created_at?: number;
}

interface LaunchContext {
  baseline: ReturnType<typeof captureProjectLaunchBaseline>;
  memory: ReturnType<typeof captureProjectMemorySnapshot>;
}

async function triggerDispatchInBackground(): Promise<void> {
  const { dispatchPendingTasks } = await import('./agent-runner.js');
  void dispatchPendingTasks().catch((error) => {
    console.error('[actions] Background dispatch failed:', error);
  });
}

function parseActionPayload(payload: string | null): Record<string, unknown> {
  if (!payload) return {};
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function projectFromPayload(payload: string | null): string | null {
  const parsed = parseActionPayload(payload);
  return typeof parsed.project === 'string' && parsed.project.trim().length > 0
    ? parsed.project.trim()
    : null;
}

export function reconcileDashboardActionStates(now = Date.now()): number {
  const db = getDb();
  const staleCutoff = now - (5 * 60 * 1000);
  const staleActions = db.prepare(`
    SELECT id, action, payload, status, result, created_at
    FROM dashboard_actions
    WHERE status = 'in_progress' AND created_at <= ?
    ORDER BY created_at ASC
  `).all(staleCutoff) as unknown as DashboardAction[];

  let reconciled = 0;

  for (const action of staleActions) {
    const project = projectFromPayload(action.payload);
    const newerTerminalActions = db.prepare(`
      SELECT id, status, result
      FROM dashboard_actions
      WHERE action = ?
        AND status IN ('completed', 'failed')
        AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(action.action, action.created_at ?? 0) as Array<{
      id: number;
      status: string;
      result: string | null;
    }>;

    const matchingTerminalAction = newerTerminalActions.find((candidate) => {
      if (!project) return true;
      const candidateProject = projectFromPayload(
        db.prepare('SELECT payload FROM dashboard_actions WHERE id = ?').get(candidate.id)?.payload as string | null ?? null,
      );
      return candidateProject === project;
    });

    if (!matchingTerminalAction) continue;

    const projectSuffix = project ? ` for ${project}` : '';
    const result = `Superseded by later ${action.action}${projectSuffix} (action #${matchingTerminalAction.id}).`;
    db.prepare(`
      UPDATE dashboard_actions
      SET status = 'completed', result = ?, completed_at = ?
      WHERE id = ?
    `).run(result, now, action.id);
    reconciled += 1;
  }

  return reconciled;
}

function captureLaunchContext(project: string, action: 'review' | 'command' | 'start', command: string | null): LaunchContext {
  return {
    baseline: captureProjectLaunchBaseline({
      projectId: project,
      action,
      command,
    }),
    memory: captureProjectMemorySnapshot(project),
  };
}

async function launchProjectReview(params: {
  project: string;
  sourceAction: 'review' | 'start';
  commandText?: string;
  startReason?: string;
}): Promise<string> {
  const { submitTask } = await import('./orchestrator.js');
  const { loadProjectPolicy } = await import('./project-policy.js');
  const project = params.project.trim();
  const policy = loadProjectPolicy(project);
  const medicalReadOnlyReview = policy.autonomySurfaces.readOnlyCanary;
  const launch = captureLaunchContext(project, params.sourceAction, params.commandText ?? 'review project');

  await submitTask({
    description: `Project review of ${project}`,
    input: {
      projectId: project,
      triggeredBy: params.sourceAction === 'start' ? 'dashboard-start' : 'dashboard',
      reviewScope: 'project',
      medicalReadOnlyReview,
      startReason: params.startReason,
      followupPolicy: medicalReadOnlyReview
        ? {
            boundedLane: 'medical_read_only',
            allowedWorkflows: policy.autonomySurfaces.readOnlyWorkflows,
            maxFollowups: 2,
            recursionDisabled: true,
          }
        : undefined,
      launchBaselineId: launch.baseline.snapshot.id,
      launchBaselinePath: launch.baseline.filePath,
      projectMemoryId: launch.memory.snapshot.id,
      projectMemoryPath: launch.memory.filePath,
      projectMemorySummary: launch.memory.snapshot.workingSummary,
    },
    projectId: project,
    workflowKind: 'review',
    sourceKind: 'dashboard',
  }, {
    agent: 'quality-agent',
    projectId: project,
    workflowKind: 'review',
    sourceKind: 'dashboard',
  });

  await triggerDispatchInBackground();

  return `Review submitted for ${project}\nReason: ${params.startReason ?? 'project review requested'}\nBaseline snapshot: ${launch.baseline.filePath}\nProject memory: ${launch.memory.filePath}`;
}

async function launchProjectWorkflow(params: {
  project: string;
  workflowKind: WorkflowKind | undefined;
  commandText: string;
  sourceAction: 'command' | 'start';
  innovationRadar?: boolean;
  startReason?: string;
}): Promise<string> {
  const { submitTask } = await import('./orchestrator.js');
  const { loadProjectPolicy } = await import('./project-policy.js');

  const project = params.project.trim();
  const policy = loadProjectPolicy(project);
  const cmd = params.commandText.trim();
  const workflowKind = params.workflowKind;
  const medicalReadOnlyReview = workflowKind === 'review' && policy.autonomySurfaces.readOnlyCanary;
  const launch = captureLaunchContext(project, params.sourceAction, cmd);

  await submitTask({
    description: params.innovationRadar ? policy.innovationRadar.description : cmd,
    input: {
      projectId: project,
      project,
      triggeredBy: params.sourceAction === 'start' ? 'dashboard-start' : 'dashboard-command',
      medicalReadOnlyReview,
      innovationRadar: params.innovationRadar === true,
      shadowMode: params.innovationRadar ? policy.innovationRadar.shadow : undefined,
      focusAreas: params.innovationRadar ? policy.innovationRadar.focusAreas : undefined,
      maxOpportunities: params.innovationRadar ? policy.innovationRadar.maxOpportunities : undefined,
      startReason: params.startReason,
      followupPolicy: medicalReadOnlyReview
        ? {
            boundedLane: 'medical_read_only',
            allowedWorkflows: policy.autonomySurfaces.readOnlyWorkflows,
            maxFollowups: 2,
            recursionDisabled: true,
          }
        : undefined,
      reviewScope: workflowKind === 'review' ? 'project' : undefined,
      launchBaselineId: launch.baseline.snapshot.id,
      launchBaselinePath: launch.baseline.filePath,
      projectMemoryId: launch.memory.snapshot.id,
      projectMemoryPath: launch.memory.filePath,
      projectMemorySummary: launch.memory.snapshot.workingSummary,
    },
    projectId: project,
    workflowKind,
    sourceKind: 'dashboard',
  }, params.innovationRadar
    ? {
        agent: policy.innovationRadar.agent,
        projectId: project,
        workflowKind,
        sourceKind: 'dashboard',
      }
    : workflowKind === 'review'
      ? {
          agent: 'quality-agent',
          projectId: project,
          workflowKind,
          sourceKind: 'dashboard',
        }
      : undefined);

  await triggerDispatchInBackground();

  return `Command submitted: ${cmd}\nReason: ${params.startReason ?? 'explicit workflow requested'}\nBaseline snapshot: ${launch.baseline.filePath}\nProject memory: ${launch.memory.filePath}`;
}

export function claimDashboardAction(actionId: number): boolean {
  const result = getDb().prepare(`
    UPDATE dashboard_actions
    SET status = 'in_progress', result = NULL, completed_at = NULL
    WHERE id = ? AND status = 'pending'
  `).run(actionId);

  return Number(result.changes ?? 0) > 0;
}

/**
 * Process pending dashboard actions.
 * Called by the scheduler each tick.
 */
export async function processDashboardActions(): Promise<void> {
  reconcileDashboardActionStates();

  // Check local DB for pending actions (synced from Turso)
  const pending = getDb().prepare(
    "SELECT id, action, payload, status FROM dashboard_actions WHERE status = 'pending'"
  ).all() as unknown as DashboardAction[];

  if (pending.length === 0) return;

  for (const action of pending) {
    if (!claimDashboardAction(action.id)) {
      continue;
    }

    console.log(`[actions] Processing: ${action.action} (id: ${action.id})`);
    const payload = action.payload ? JSON.parse(action.payload) : {};

    try {
      let result: string;

      switch (action.action) {
        case 'start': {
          if (typeof payload.project !== 'string' || payload.project.trim().length === 0) {
            throw new Error('Dashboard start action requires an explicit project.');
          }

          const project = payload.project.trim();
          const decision = decideProjectStart(project);

          if (decision.mode === 'continue') {
            await triggerDispatchInBackground();
            result = `Continuing current work for ${project}\nReason: ${decision.reason}`;
            break;
          }

          if (decision.workflowKind === 'review') {
            result = await launchProjectReview({
              project,
              sourceAction: 'start',
              commandText: decision.command ?? 'review project',
              startReason: decision.reason,
            });
            break;
          }

          result = await launchProjectWorkflow({
            project,
            workflowKind: decision.workflowKind,
            commandText: decision.command ?? `review ${project}`,
            sourceAction: 'start',
            startReason: decision.reason,
          });
          break;
        }
        case 'review': {
          if (typeof payload.project !== 'string' || payload.project.trim().length === 0) {
            throw new Error('Dashboard review action requires an explicit project.');
          }
          result = await launchProjectReview({
            project: payload.project.trim(),
            sourceAction: 'review',
            commandText: 'review project',
          });
          break;
        }
        case 'execute': {
          const { dispatchPendingTasks } = await import('./agent-runner.js');
          await dispatchPendingTasks();
          result = 'Dispatched pending tasks';
          break;
        }
        case 'status': {
          result = 'Status check completed';
          break;
        }
        case 'command': {
          const cmd = typeof payload.command === 'string' ? payload.command.trim() : '';
          if (!cmd) {
            throw new Error('Dashboard command action requires a non-empty command.');
          }
          if (typeof payload.project !== 'string' || payload.project.trim().length === 0) {
            throw new Error('Dashboard command action requires an explicit project.');
          }
          const project = payload.project.trim();
          const innovationRadarCommand = /^\s*(innovation\s+radar|radar)\b/i.test(cmd);
          const inferredReview = /^\s*(canary\s+)?review\b/i.test(cmd) || /^\s*(healthy\s+run|run\s+a\s+healthy\s+run)\b/i.test(cmd);
          const workflowKind = (typeof payload.workflowKind === 'string'
            ? payload.workflowKind
            : innovationRadarCommand
              ? 'review'
              : inferredReview
              ? 'review'
              : undefined) as WorkflowKind | undefined;
          result = await launchProjectWorkflow({
            project,
            workflowKind,
            commandText: cmd,
            sourceAction: 'command',
            innovationRadar: innovationRadarCommand,
          });
          break;
        }
        default:
          result = `Unknown action: ${action.action}`;
      }

      getDb().prepare(
        "UPDATE dashboard_actions SET status = 'completed', result = ?, completed_at = ? WHERE id = ?"
      ).run(result, Date.now(), action.id);

      console.log(`[actions] Completed: ${action.action} — ${result}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      getDb().prepare(
        "UPDATE dashboard_actions SET status = 'failed', result = ?, completed_at = ? WHERE id = ?"
      ).run(errMsg, Date.now(), action.id);
      console.error(`[actions] Failed: ${action.action} — ${errMsg}`);
    }
  }
}
