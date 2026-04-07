import { BaseAgent } from '../../_base/agent.js';
import { callModelUltra } from '../../_base/mcp-client.js';
import { Task } from '../../../packages/shared/src/types.js';
import { getTask, createTask, completeTask, countRevisions, getRevisionChainCost } from '../../../packages/core/src/task-queue.js';
import { writeAudit } from '../../../packages/core/src/audit.js';
import { triggerG4Gate } from '../../../packages/core/src/gates.js';
import { MAX_REVISIONS, REVISION_COST_CAP } from '../../../packages/core/src/budget.js';

const QA_SYSTEM = `You are the Quality Agent for Organism. You review outputs from other agents using the autoresearch method.

Method: for every output you review, generate 3 alternative approaches, score each out of 10, identify the best, and give a final verdict.

Output format (strictly follow this):
## Quality Review

**Decision:** APPROVED | NEEDS_REVISION

**Score:** X/10

**Task:** [restate the original task in one line]

**Approaches considered:**
1. [approach name] — Score: X/10 — [one sentence rationale]
2. [approach name] — Score: X/10 — [one sentence rationale]
3. [approach name] — Score: X/10 — [one sentence rationale]

**Actual output assessment:** [2-3 sentences — how does the actual output compare to the alternatives?]

**Issues (if any):**
- [specific issue, or "None"]

**Verdict:** [one sentence — APPROVED or what specifically needs revision]

Rules:
- Score honestly. A 10/10 means nothing could be better.
- NEEDS_REVISION only if a specific, actionable improvement is identified.
- Be terse. The review itself should not exceed 300 words.`;

export default class QualityAgent extends BaseAgent {
  constructor() {
    super({
      name: 'quality-agent',
      model: 'sonnet',
      capability: {
        id: 'quality.review',
        owner: 'quality-agent',
        collaborators: [],
        reviewerLane: 'LOW',
        description: 'Autoresearch quality review — generates 3+ approaches and scores them',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const rawOutput = (input?.output as string) ?? '';
    // Cap review payload at ~2K tokens to control cost — quality-agent is a lightweight gate
    const originalOutput = rawOutput.slice(0, 4000);
    const originalDesc = (input?.originalDescription as string) ?? task.description;
    const originalTaskId = (input?.originalTaskId as string) ?? '';

    // Batch reviews use Haiku (cheap triage); single reviews use Sonnet
    const isBatchReview = task.description.startsWith('Batch quality review');
    const model = isBatchReview ? 'haiku' : 'sonnet';

    const prompt = `Review the following agent output.

Original task: ${originalDesc}

Output to review:
---
${originalOutput}
---

Apply the autoresearch method: generate 3 alternative approaches, score the actual output against them, and give your verdict.`;

    const result = await callModelUltra(prompt, model as 'haiku' | 'sonnet' | 'opus', QA_SYSTEM);

    const approved = result.text.includes('**Decision:** APPROVED') ||
                     result.text.includes('Decision: APPROVED');

    // For HIGH-lane parent tasks: trigger G4 board gate instead of auto-ship
    if (originalTaskId) {
      const parentTask = getTask(originalTaskId);
      if (parentTask?.lane === 'HIGH' && approved) {
        triggerG4Gate(
          originalTaskId,
          `Quality review APPROVED.\n\nOriginal task: ${originalDesc}\n\nReview summary:\n${result.text.slice(0, 600)}`
        );
      }

      // AUTO-APPROVAL: LOW-lane tasks that pass quality review skip Rafael's review queue.
      // They are auto-completed with an audit trail so we can track them.
      // MEDIUM and HIGH always require human review.
      if (parentTask?.lane === 'LOW' && approved) {
        try {
          // Only auto-complete if the parent task is still in a completable state
          // (awaiting_review or completed but not yet decided on)
          if (parentTask.status === 'awaiting_review' || parentTask.status === 'completed') {
            completeTask(parentTask.id, parentTask.output, parentTask.tokensUsed ?? 0, parentTask.costUsd ?? 0);
            console.log(`[quality-agent] AUTO-APPROVED LOW-lane task ${parentTask.id} (${parentTask.agent}: "${parentTask.description.slice(0, 60)}")`);
          }

          writeAudit({
            agent: 'quality-agent',
            taskId: parentTask.id,
            action: 'auto_approved',
            payload: {
              originalAgent: parentTask.agent,
              lane: parentTask.lane,
              qualityScore: result.text.match(/Score:\s*(\d+)/)?.[1] ?? 'unknown',
              reviewSummary: result.text.slice(0, 300),
            },
            outcome: 'success',
          });
        } catch (err) {
          console.warn(`[quality-agent] Failed to auto-approve LOW-lane task ${parentTask.id}: ${err}`);
        }
      }
    }

    // Quality feedback loop: if review contains CRITICAL/REJECT signals, create a
    // revision task for the original agent so it can address the feedback.
    if (!approved && originalTaskId) {
      const hasCritical = /\bCRITICAL\b|\bREJECT\b|\bREVISION NEEDED\b/i.test(result.text);
      if (hasCritical) {
        const parentTask = getTask(originalTaskId);
        if (parentTask) {
          const originalId = (task.input as Record<string, unknown>)?.originalTaskId as string ?? task.id;
          const revCount = countRevisions(originalId);
          const chainCost = getRevisionChainCost(originalId);
          if (revCount >= MAX_REVISIONS) {
            console.warn(`[quality-agent] Revision cap reached (${revCount}/${MAX_REVISIONS}) for ${originalId} — skipping`);
          } else if (chainCost >= REVISION_COST_CAP) {
            console.warn(`[quality-agent] Revision cost cap reached ($${chainCost.toFixed(2)}/$${REVISION_COST_CAP}) for ${originalId} — skipping`);
          } else {
            try {
              createTask({
                agent: parentTask.agent,
                lane: 'LOW', // revision is remediation, not a new risk
                description: `Revision needed: quality review flagged critical issues in "${parentTask.description.slice(0, 80)}"`,
                input: {
                  qualityFeedback: result.text,
                  originalTaskId,
                  originalDescription: parentTask.description,
                },
                parentTaskId: originalTaskId,
                projectId: parentTask.projectId ?? 'organism',
              });
              console.log(`[quality-agent] Revision task created for '${parentTask.agent}' (original task ${originalTaskId})`);
            } catch {
              // Duplicate detection may fire — safe to ignore
              console.warn(`[quality-agent] Could not create revision task for ${originalTaskId}`);
            }
          }
        }
      }
    }

    // AUTO-APPROVAL for batch reviews: each LOW-lane task in the batch gets an
    // auto_approved audit entry so the dashboard excludes them from the review queue.
    if (approved && !originalTaskId) {
      const batched = (input?.batchedOutputs as Array<{ taskId: string }>) ?? [];
      for (const item of batched) {
        if (!item.taskId) continue;
        try {
          const batchedTask = getTask(item.taskId);
          if (batchedTask?.lane === 'LOW') {
            writeAudit({
              agent: 'quality-agent',
              taskId: item.taskId,
              action: 'auto_approved',
              payload: {
                originalAgent: batchedTask.agent,
                lane: 'LOW',
                reviewType: 'batch',
                qualityScore: result.text.match(/Score:\s*(\d+)/)?.[1] ?? 'unknown',
              },
              outcome: 'success',
            });
          }
        } catch {
          // Non-critical — task may have been deleted or already processed
        }
      }
    }

    return {
      output: {
        review: result.text,
        decision: approved ? 'APPROVED' : 'NEEDS_REVISION',
        originalTaskId,
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
