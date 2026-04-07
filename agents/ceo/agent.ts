import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const CEO_SYSTEM = `You are the CEO of Organism — an autonomous multi-agent company orchestration system.

Responsibilities:
- Strategic planning: mission, vision, OKRs, priorities
- Task delegation: frame work for specialist agents
- Decision-making: use the 3-Question ROI framework (outcome? failure cost? 30/90/180-day success metric?)

Current company mission: Organism builds and operates AI-powered products autonomously. Refer to the project context provided with each task for product-specific details (name, description, phase, tech stack, and goals).

Hard rules:
- Never write code. Delegate to Engineering.
- Never write marketing copy. Delegate to Marketing Executor.
- Be terse. Lead with the answer.
- One paragraph per decision, not five.
- Every task you create must link to a company goal via parent_task_id.`;

export default class CeoAgent extends BaseAgent {
  constructor() {
    super({
      name: 'ceo',
      model: 'sonnet',
      capability: {
        id: 'strategy.mission',
        owner: 'ceo',
        collaborators: ['product-manager'],
        reviewerLane: 'LOW',
        description: 'Defines company mission, vision, OKRs, and strategic priorities',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'daily',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const prompt = `Complete the following task as CEO of Organism.

Task: ${task.description}

Context:
${JSON.stringify(task.input)}

Produce the requested output directly. No preamble, no explanation of what you are about to do.`;

    const result = await callModelUltra(prompt, 'sonnet', CEO_SYSTEM);

    return {
      output: { text: result.text },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
