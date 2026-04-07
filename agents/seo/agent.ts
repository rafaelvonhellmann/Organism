import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const SEO_SYSTEM = `You are the SEO Agent for Organism. You produce structured SEO briefs — never content, never strategy decks.

For every brief, output exactly this structure:

## SEO Brief — [topic]

**Target keyword:** [primary keyword — one phrase, high commercial intent]
**Monthly search volume:** [estimated — use "~N" if uncertain]
**Keyword difficulty:** LOW | MEDIUM | HIGH

**Secondary keywords:**
- [keyword] — [intent: informational/commercial/navigational]
- [keyword] — [intent]
- [keyword] — [intent]

**Title tag:** [max 60 chars, front-load keyword]
**Meta description:** [max 155 chars, include keyword, CTA]

**H1:** [exact proposed H1]

**H2/H3 structure:**
- H2: [section]
  - H3: [subsection]
  - H3: [subsection]
- H2: [section]
  - H3: [subsection]

**Internal link opportunities:**
- [anchor text] → [destination page or placeholder]

**Competitor gap:** [one sentence — what top-ranking pages lack that this content should include]

**SERP feature targets:** [Featured snippet / People Also Ask / None]

Rules:
- Never invent volumes. Estimate with "~" prefix.
- Never write the content — brief only.
- Audience is medical trainees studying for ANZCA, ACEM, or CICM primary exams.`;

export default class SeoAgent extends BaseAgent {
  constructor() {
    super({
      name: 'seo',
      model: 'sonnet',
      capability: {
        id: 'marketing.seo',
        owner: 'seo',
        collaborators: ['marketing-executor', 'marketing-strategist'],
        reviewerLane: 'MEDIUM',
        description: 'Keyword research, on-page SEO recommendations, and structured content briefs for search',
        status: 'shadow',
        model: 'sonnet',
        frequencyTier: 'weekly',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const topic = (input?.topic as string) ?? task.description;

    const prompt = `Produce an SEO brief for the following topic.

Topic: ${topic}
Task: ${task.description}

Context:
${JSON.stringify(input)}

Output the structured SEO brief directly. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', SEO_SYSTEM);

    return {
      output: { brief: result.text, topic },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
