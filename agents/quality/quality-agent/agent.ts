import { BaseAgent } from '../../_base/agent.js';
import { callModelUltra } from '../../_base/mcp-client.js';
import { Task } from '../../../packages/shared/src/types.js';
import { getTask } from '../../../packages/core/src/task-queue.js';
import { triggerG4Gate } from '../../../packages/core/src/gates.js';

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
    const originalOutput = (input?.output as string) ?? '';
    const originalDesc = (input?.originalDescription as string) ?? task.description;
    const originalTaskId = (input?.originalTaskId as string) ?? '';

    const prompt = `Review the following agent output.

Original task: ${originalDesc}

Output to review:
---
${originalOutput}
---

Apply the autoresearch method: generate 3 alternative approaches, score the actual output against them, and give your verdict.`;

    const result = await callModelUltra(prompt, 'sonnet', QA_SYSTEM);

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
