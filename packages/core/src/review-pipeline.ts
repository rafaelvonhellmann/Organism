import { writeAudit } from './audit.js';
import {
  completeTask,
  failTask,
  getTask,
  getTaskReviewSummary,
  recordTaskReviewDecision,
} from './task-queue.js';
import { hasPendingG4GateForTask, triggerG4Gate } from './gates.js';

export interface ReviewDecisionResult {
  tracked: boolean;
  finalized: boolean;
  blocked: boolean;
  g4Triggered: boolean;
}

export function applyTaskReviewDecision(params: {
  parentTaskId: string;
  reviewer: string;
  reviewTaskId?: string | null;
  approved: boolean;
  decision: string;
  summary?: string;
  reason?: string | null;
}): ReviewDecisionResult {
  const tracked = recordTaskReviewDecision({
    parentTaskId: params.parentTaskId,
    reviewer: params.reviewer,
    reviewTaskId: params.reviewTaskId ?? null,
    approved: params.approved,
    decision: params.decision,
    reason: params.reason ?? null,
  });

  if (!tracked) {
    return { tracked: false, finalized: false, blocked: false, g4Triggered: false };
  }

  const parentTask = getTask(params.parentTaskId);
  if (!parentTask) {
    return { tracked: true, finalized: false, blocked: false, g4Triggered: false };
  }

  writeAudit({
    agent: params.reviewer,
    taskId: parentTask.id,
    action: 'gate_eval',
    payload: {
      type: 'pipeline_review',
      reviewer: params.reviewer,
      decision: params.decision,
      reviewTaskId: params.reviewTaskId ?? null,
      summary: params.summary?.slice(0, 400) ?? null,
    },
    outcome: params.approved ? 'success' : 'blocked',
  });

  if (!params.approved) {
    if (parentTask.status === 'awaiting_review') {
      failTask(parentTask.id, params.reason ?? `${params.reviewer} review requires revision (${params.decision})`);
    }
    return { tracked: true, finalized: false, blocked: true, g4Triggered: false };
  }

  const summary = getTaskReviewSummary(parentTask.id);
  if (!summary.allApproved) {
    return { tracked: true, finalized: false, blocked: false, g4Triggered: false };
  }

  if (parentTask.lane === 'HIGH') {
    if (!hasPendingG4GateForTask(parentTask.id)) {
      const reviewSummary = [
        `All required review stages approved for "${parentTask.description.slice(0, 160)}".`,
        `Approved reviewers: ${summary.approvedReviewers.join(', ') || 'none'}.`,
        params.summary ? `Latest review summary: ${params.summary.slice(0, 800)}` : null,
      ].filter(Boolean).join('\n\n');
      triggerG4Gate(parentTask.id, reviewSummary);
      return { tracked: true, finalized: false, blocked: false, g4Triggered: true };
    }
    return { tracked: true, finalized: false, blocked: false, g4Triggered: false };
  }

  if (parentTask.status === 'awaiting_review') {
    completeTask(parentTask.id, parentTask.output, parentTask.tokensUsed ?? 0, parentTask.costUsd ?? 0);
  }

  writeAudit({
    agent: params.reviewer,
    taskId: parentTask.id,
    action: 'auto_approved',
    payload: {
      type: 'pipeline_complete',
      lane: parentTask.lane,
      reviewers: summary.approvedReviewers,
    },
    outcome: 'success',
  });

  return { tracked: true, finalized: true, blocked: false, g4Triggered: false };
}
