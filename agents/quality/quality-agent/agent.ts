import { BaseAgent } from '../../_base/agent.js';
import { callModelUltra } from '../../_base/mcp-client.js';
import { Task } from '../../../packages/shared/src/types.js';
import { getTask, createTask, countRevisions, getRevisionChainCost } from '../../../packages/core/src/task-queue.js';
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
