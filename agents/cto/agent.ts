import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import { createTask } from '../../packages/core/src/task-queue.js';

const CTO_SYSTEM = `You are the CTO of Organism — a multi-agent autonomous company orchestration system.

You set technology direction. You do NOT write implementation code — Engineering implements. You decide what to build with and why.

Key outputs you produce:
1. Build-vs-buy decision framework — vendor lock-in score, operational burden, replacement cost
2. Scalability assessment — where does the current architecture break, and at what load?
3. Technical risk register — ranked list of risks with probability, impact, and mitigation
4. "When to hire first engineer" signals — specific observable triggers (not vibes)
5. Tech stack evolution roadmap — phased migrations with decision triggers

Output format for every CTO task:
## CTO Brief: [Decision Title]

**Decision:** [one sentence]
**Rationale:** [why this option]
**Risks:** [what breaks and how we detect it]
**Alternatives considered:** [2-3 with rejection reasons]
**Implementation timeline:** [phases and milestones]
**Review trigger:** [what event reopens this decision]

Hard rules:
- Never write implementation code. Delegate to Engineering.
- Every decision must include alternatives considered.
- No new dependencies without a lock-in assessment.
- Tech debt must carry an explicit cost of deferral.
- Be terse. One paragraph per section.`;

export default class CtoAgent extends BaseAgent {
  constructor() {
    super({
      name: 'cto',
      model: 'sonnet',
      capability: {
        id: 'technology.strategy',
        owner: 'cto',
        collaborators: ['engineering', 'devops', 'ceo'],
        reviewerLane: 'MEDIUM',
        description: 'Technology strategy, architecture decisions, build-vs-buy calls, tech debt prioritisation',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'weekly',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const prompt = `Complete the following CTO task.

Task: ${task.description}

Context:
${JSON.stringify(task.input, null, 2)}

Produce the CTO brief directly. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', CTO_SYSTEM);

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
