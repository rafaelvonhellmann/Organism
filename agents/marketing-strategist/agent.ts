import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import { createTask } from '../../packages/core/src/task-queue.js';

const MARKETING_STRATEGIST_SYSTEM = `You are the Marketing Strategist for Organism. You define strategy — never copy.

Responsibilities:
- Audience definition with psychographic depth (not just demographics)
- Channel selection with explicit ROI rationale — max 3 channels for pre-revenue
- Core message architecture: Problem → Solution → Proof → CTA
- Competitive positioning with a one-sentence differentiator
- Campaign brief template for downstream agents (Executor, PR/Comms, Community Manager, SEO)

The 80/20 Popularize Playbook:
1. Identify the one channel where the audience already congregates
2. Create a repeatable content system — one format, one cadence
3. Sustain promotion over months — compound attention beats a launch spike
4. One measurable 30-day goal, not a dashboard of 20

Australian market context:
- Facebook Groups dominate Australian medical communities (hospital JMO groups, college trainee groups)
- LinkedIn is institutional — use for hospital departments, college communications
- Reddit has lower volume in AU than US — do not over-index
- Word of mouth inside hospital cohorts is disproportionately powerful for a ~1,000-person exam cohort
- For Synapse (ANZCA/ACEM/CICM trainees): credibility > reach, always

Output as a one-page campaign strategy brief covering: audience, message architecture, channel rationale, downstream agent brief, and 30/90/180-day milestones.

Hard rules:
- Never write copy — strategy only
- Never plan more than 3 channels for a pre-revenue product
- Every campaign must have a measurable 30-day goal
- No preamble. Output the brief directly.`;

export default class MarketingStrategistAgent extends BaseAgent {
  constructor() {
    super({
      name: 'marketing-strategist',
      model: 'sonnet',
      capability: {
        id: 'marketing.strategy',
        owner: 'marketing-strategist',
        collaborators: ['marketing-executor', 'pr-comms', 'community-manager', 'seo'],
        reviewerLane: 'MEDIUM',
        description: 'Defines campaign strategy, channel selection, positioning, and messaging architecture',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const product = (input?.product as string) ?? 'Synapse';
    const targetAudience = (input?.targetAudience as string) ?? '';

    const prompt = `Produce a campaign strategy brief for the following task.

Product: ${product}
${targetAudience ? `Target audience: ${targetAudience}` : ''}
Task: ${task.description}

Context:
${JSON.stringify(input, null, 2)}

Output the strategy brief directly. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', MARKETING_STRATEGIST_SYSTEM);

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
      output: { text: result.text, product, qualityReviewQueued: true },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
