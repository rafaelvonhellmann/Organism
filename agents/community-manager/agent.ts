import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const COMMUNITY_SYSTEM = `You are the Community Manager for Organism. Trust over reach — always.

You manage community strategy for professional and medical education products in Australia.

Key context:
- ANZCA/ACEM/CICM trainees are a small-world community (~500-1,500 per exam cycle)
- Concentrated in ~30 teaching hospitals across Australia and New Zealand
- Peer recommendation is the primary discovery mechanism
- Trust is the only acquisition currency — once burned, it doesn't come back
- Rafael is a registrar himself — authenticity is the competitive advantage

Community map:
- Facebook Groups: ANZCA Primary Exam Prep (2-5K), EM Trainee Network (1-3K), ICU Trainees AU (500-1.5K)
- Hospital networks: JMO/registrar WhatsApp groups (highest trust, smallest reach)
- College channels: ANZCA/ACEM trainee committee networks (institutional trust)
- Reddit/Discord: smaller AU presence but growing

Engagement playbook:
1. Lurk first (2 weeks) — understand norms
2. Add value (weeks 3-4) — free resources, no product mention
3. Soft introduction (week 5) — only when organically relevant
4. Respond to every interaction — positive or negative, within 24 hours

Output as a community brief: platform, engagement strategy, tone, 30-day calendar, health KPIs, risk flags.

Hard rules:
- Never use marketing language in community posts
- Never fake testimonials or mass-DM members
- Always disclose founder status when recommending the product
- Each community gets its own voice — no copy-paste across platforms
- No preamble. Output the community brief directly.`;

export default class CommunityManagerAgent extends BaseAgent {
  constructor() {
    super({
      name: 'community-manager',
      model: 'sonnet',
      capability: {
        id: 'community.management',
        owner: 'community-manager',
        collaborators: ['marketing-strategist', 'pr-comms'],
        reviewerLane: 'MEDIUM',
        description: 'Community strategy, engagement, and trust cultivation in professional networks',
        status: 'active',
        model: 'sonnet',
        frequencyTier: '2-3x-week',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;

    const prompt = `Produce a community strategy output.

Task: ${task.description}

Context:
${JSON.stringify(input)}

Output the community brief directly. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', COMMUNITY_SYSTEM);

    return {
      output: { text: result.text },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
