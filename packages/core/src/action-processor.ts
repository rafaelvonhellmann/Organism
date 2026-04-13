import { getDb } from './task-queue.js';
import { captureProjectLaunchBaseline } from './launch-baseline.js';

interface DashboardAction {
  id: number;
  action: string;
  payload: string | null;
  status: string;
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
        case 'review': {
          // Dynamic import to avoid circular deps
          const { submitTask } = await import('./orchestrator.js');
          const { dispatchPendingTasks } = await import('./agent-runner.js');
          const { loadProjectPolicy } = await import('./project-policy.js');
          if (typeof payload.project !== 'string' || payload.project.trim().length === 0) {
            throw new Error('Dashboard review action requires an explicit project.');
          }
          const project = payload.project.trim();
          const policy = loadProjectPolicy(project);
          const medicalReadOnlyCanary = payload.canaryPreset === true && policy.autonomySurfaces.readOnlyCanary;
          const baseline = captureProjectLaunchBaseline({
            projectId: project,
            action: 'review',
            command: payload.canaryPreset === true ? 'canary review project' : 'review project',
          });
          await submitTask({
            description: payload.canaryPreset === true
              ? `Canary review of ${project} repository`
              : `Full review of ${project} repository`,
            input: {
              projectId: project,
              triggeredBy: 'dashboard',
              reviewScope: 'project',
              canaryPreset: payload.canaryPreset === true,
              medicalReadOnlyCanary,
              followupPolicy: medicalReadOnlyCanary
                ? {
                    boundedLane: 'medical_read_only',
                    allowedWorkflows: policy.autonomySurfaces.readOnlyWorkflows,
                    maxFollowups: 2,
                    recursionDisabled: true,
                  }
                : undefined,
              launchBaselineId: baseline.snapshot.id,
              launchBaselinePath: baseline.filePath,
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
          await dispatchPendingTasks();
          result = payload.canaryPreset === true
            ? `Canary repo review submitted and dispatched for ${project}\nBaseline snapshot: ${baseline.filePath}`
            : `Review submitted and dispatched for ${project}\nBaseline snapshot: ${baseline.filePath}`;
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
          const { loadProjectPolicy } = await import('./project-policy.js');
          const policy = loadProjectPolicy(project);
          const inferredReview = /^\s*(canary\s+)?review\b/i.test(cmd);
          const workflowKind = typeof payload.workflowKind === 'string'
            ? payload.workflowKind
            : inferredReview
              ? 'review'
              : undefined;
          const medicalReadOnlyCanary = payload.canaryPreset === true && workflowKind === 'review' && policy.autonomySurfaces.readOnlyCanary;
          const baseline = captureProjectLaunchBaseline({
            projectId: project,
            action: 'command',
            command: cmd,
          });
          const { submitTask } = await import('./orchestrator.js');
          const { dispatchPendingTasks } = await import('./agent-runner.js');
          await submitTask({
            description: cmd,
            input: {
              projectId: project,
              triggeredBy: 'dashboard-command',
              canaryPreset: payload.canaryPreset === true,
              medicalReadOnlyCanary,
              followupPolicy: medicalReadOnlyCanary
                ? {
                    boundedLane: 'medical_read_only',
                    allowedWorkflows: policy.autonomySurfaces.readOnlyWorkflows,
                    maxFollowups: 2,
                    recursionDisabled: true,
                  }
                : undefined,
              reviewScope: workflowKind === 'review' ? 'project' : undefined,
              launchBaselineId: baseline.snapshot.id,
              launchBaselinePath: baseline.filePath,
            },
            projectId: project,
            workflowKind,
            sourceKind: 'dashboard',
          }, workflowKind === 'review'
            ? {
                agent: 'quality-agent',
                projectId: project,
                workflowKind,
                sourceKind: 'dashboard',
              }
            : undefined);
          await dispatchPendingTasks();
          result = `Command submitted and dispatched: ${cmd}\nBaseline snapshot: ${baseline.filePath}`;
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
