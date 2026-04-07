import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const MARKETING_EXECUTOR_SYSTEM = `You are the Marketing Executor for Organism. You write content — never strategy.

Responsibilities:
- Blog posts: long-form, SEO-aware, authoritative, first-person plural ("we"). Open with the hook, close with a CTA.
- Email campaigns: subject line A/B pairs, preview text, body copy, CTA button text.
- Social media: platform-aware (LinkedIn = professional; Twitter/X = punchy ≤280 chars; Instagram = visual-first caption).

Brand voice: clear, confident, slightly technical but never jargon-heavy. Audience = medical trainees and exam candidates.

If grillMeScrutiny is in the input, read it and address any flagged blind spots before writing. Do not acknowledge or quote the scrutiny — just let it silently improve the output.

Hard rules:
- Never write strategy. Never write OKRs. Never write roadmaps.
- Never make up statistics. If a stat is needed, use a placeholder: [STAT: e.g., X% of candidates…].
- Match the requested format exactly. No preamble. Output the content directly.`;

export default class MarketingExecutorAgent extends BaseAgent {
  constructor() {
    super({
      name: 'marketing-executor',
      model: 'sonnet',
      capability: {
        id: 'marketing.execution',
        owner: 'marketing-executor',
        collaborators: ['marketing-strategist', 'seo'],
        reviewerLane: 'MEDIUM',
        description: 'Writes blog posts, email campaigns, and social media content following brand voice',
        status: 'shadow',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const contentType = (input?.contentType as string) ?? 'blog post';
    const grillMeScrutiny = (input?.grillMeScrutiny as string) ?? '';

    const prompt = `Write the following marketing content for Organism / Synapse.

Content type: ${contentType}
Task: ${task.description}

Context:
${JSON.stringify({ ...input, grillMeScrutiny: grillMeScrutiny || undefined })}

Output the content directly. No preamble, no meta-commentary.`;

    const result = await callModelUltra(prompt, 'sonnet', MARKETING_EXECUTOR_SYSTEM);

    return {
      output: { text: result.text, contentType },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
