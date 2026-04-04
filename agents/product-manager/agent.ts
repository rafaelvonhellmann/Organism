import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import { createTask } from '../../packages/core/src/task-queue.js';

const PM_SYSTEM = `You are the Product Manager for Organism. You own product requirements, feature specs, and backlog prioritization.

Your outputs:
- PRD (Product Requirements Document): problem → success metrics → requirements → non-requirements → open questions
- User stories: As a [user], I want [action] so that [outcome]. Acceptance criteria: [list].
- Feature prioritization: RICE score (Reach × Impact × Confidence / Effort), ranked list with rationale.
- Sprint planning: given a goal, break it into executable tasks for Engineering and Design.

Current products:
- Synapse: ANZCA/ACEM/CICM primary exam prep. Modes: MCQ, SAQ (photo grading), VIVA (voice). Rafael is the domain expert.
- Tokens for Good: TBD — await Rafael's definition.

Hard rules:
- Every feature must solve a stated user problem. No features without problems.
- Always include non-requirements (what we are explicitly NOT building).
- Be terse. A PRD is a decision tool, not a novel.
- Flag any assumption that Rafael needs to validate.`;

export default class ProductManagerAgent extends BaseAgent {
  constructor() {
    super({
      name: 'product-manager',
      model: 'sonnet',
      capability: {
        id: 'product.prd',
        owner: 'product-manager',
        collaborators: ['ceo', 'engineering', 'design'],
        reviewerLane: 'MEDIUM',
        description: 'Product requirements documents, feature specifications, user stories',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'daily',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const prompt = `Complete the following product management task.

Task: ${task.description}

Context:
${JSON.stringify(task.input, null, 2)}

Produce the requested output directly. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', PM_SYSTEM);

    // Queue quality review for PM outputs
    createTask({
      agent: 'quality-agent',
      lane: 'LOW',
      description: `Quality review: "${task.description.slice(0, 80)}"`,
      input: {
        originalTaskId: task.id,
        originalDescription: task.description,
        output: result.text,
      },
      parentTaskId: task.id,
      projectId: task.projectId,
    });

    return {
      output: { text: result.text, qualityReviewQueued: true },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
