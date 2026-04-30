/**
 * Safe one-task Synapse canary.
 *
 * This intentionally dispatches only the task it creates. Do not replace this
 * with dispatchPendingTasks(); that drains the whole queue and can revive
 * unrelated recovery work during a read-only project test.
 */

import * as path from 'path';
import { bootstrapRuntimeEnv } from '../packages/shared/src/runtime-env.js';
bootstrapRuntimeEnv(path.resolve(import.meta.dirname, '..'));

import { dispatchTaskById } from '../packages/core/src/agent-runner.js';
import { submitTask } from '../packages/core/src/orchestrator.js';
import { getTask } from '../packages/core/src/task-queue.js';

function summarizeOutput(output: unknown): { summary: string; findings: string[] } {
  if (!output || typeof output !== 'object') {
    return { summary: 'No structured canary output was returned.', findings: [] };
  }
  const record = output as Record<string, unknown>;
  const summary = typeof record.summary === 'string'
    ? record.summary
    : 'Canary completed without a summary.';
  const findings = Array.isArray(record.findings)
    ? record.findings
      .filter((finding): finding is Record<string, unknown> => !!finding && typeof finding === 'object')
      .map((finding) => {
        const severity = typeof finding.severity === 'string' ? finding.severity : 'INFO';
        const text = typeof finding.summary === 'string' ? finding.summary : JSON.stringify(finding);
        return `${severity}: ${text}`;
      })
    : [];
  return { summary, findings };
}

async function main(): Promise<void> {
  const description = [
    'Medical-safe read-only canary review for Synapse.',
    'Validate that Organism can inspect Synapse repository readiness through the quality-agent canary path.',
    'Do not edit files, do not deploy, do not contact anyone, do not change content or grading behavior.',
    'Report whether the next safe Organism step should be review, validation, planning, or pause.',
  ].join(' ');

  const taskId = await submitTask(
    {
      title: 'Synapse read-only canary review',
      description,
      input: {
        projectId: 'synapse',
        reviewScope: 'project',
        canaryPreset: true,
        medicalReadOnlyCanary: true,
        triggeredBy: 'manual-test',
        requestedOutcome: 'Confirm Organism can safely run a Synapse canary and identify any blockers.',
      },
      projectId: 'synapse',
      workflowKind: 'review',
      sourceKind: 'user',
    },
    {
      agent: 'quality-agent',
      projectId: 'synapse',
      workflowKind: 'review',
      sourceKind: 'user',
    },
  );

  console.log(`Created Synapse canary task ${taskId}`);
  await dispatchTaskById(taskId);

  const task = getTask(taskId);
  if (!task) {
    throw new Error(`Canary task ${taskId} disappeared`);
  }
  if (task.status !== 'completed') {
    throw new Error(`Canary task ${taskId} ended as ${task.status}: ${task.error ?? 'no error'}`);
  }

  const { summary, findings } = summarizeOutput(task.output);
  console.log(`Synapse canary completed: ${summary}`);
  for (const finding of findings) {
    console.log(`- ${finding}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
