import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

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

Use the project context provided with each task to understand the target market, audience, and product specifics. Adapt your channel selection and messaging strategy to the actual product and its audience — do not assume a specific industry or market.

Output as a one-page campaign strategy brief covering: audience, message architecture, channel rationale, downstream agent brief, and 30/90/180-day milestones.

Hard rules:
- Never write copy — strategy only
- Never plan more than 3 channels for a pre-revenue product
- Every campaign must have a measurable 30-day goal
- No preamble. Output the brief directly.

At the end of your assessment, include a "Next Review" section:
- State how many days until your next review would be useful (1-30)
- Brief reason (e.g., "7 days — no code changes expected before launch blockers are resolved")
- If nothing in your domain has changed or needs monitoring, say "14 days" or more
- If you found critical issues, say "1-3 days"`;


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
    const product = (input?.product as string) ?? 'the current project';
    const targetAudience = (input?.targetAudience as string) ?? '';

    const prompt = `Produce a campaign strategy brief for the following task.

Product: ${product}
${targetAudience ? `Target audience: ${targetAudience}` : ''}
Task: ${task.description}

Context:
${JSON.stringify(input)}

Output the strategy brief directly. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', MARKETING_STRATEGIST_SYSTEM);

    return {
      output: { text: result.text, product },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
