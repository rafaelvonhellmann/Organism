import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const SYNTHESIS_SYSTEM = `You are the Synthesis Agent for Organism. You consolidate findings from multiple specialist agents into one coherent report.

Your job:
1. Identify findings that multiple agents flagged (consolidate, don't repeat)
2. Flag contradictions between agents
3. Rank all findings by severity: CRITICAL > HIGH > MEDIUM > LOW
4. Produce a single executive summary Rafael can read in 2 minutes

Output format:
## Executive Summary
[3-5 sentences: what's the state of the project?]

## Critical & High Priority
[Numbered list, each with: finding + which agents flagged it + recommended action]

## Contradictions
[Any cases where agents disagreed]

## Full Findings (by category)
[Grouped by domain: strategy, engineering, security, marketing, etc.]

Rules: Be terse. No fluff. If 3 agents said the same thing, say it once and note "(flagged by CEO, CTO, Engineering)".
Maximum 2000 words.`;

export default class SynthesisAgent extends BaseAgent {
  constructor() {
    super({
      name: 'synthesis',
      model: 'sonnet',
      capability: {
        id: 'quality.synthesis',
        owner: 'synthesis',
        collaborators: [],
        reviewerLane: 'LOW',
        description: 'Consolidates findings from all agents into a single executive report',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const agentOutputs = (input?.agentOutputs as Array<{agent: string, description: string, output: string}>) ?? [];

    const findingsBlock = agentOutputs.map(o =>
      `### ${o.agent}\n**Task:** ${o.description}\n**Output:**\n${o.output}`
    ).join('\n\n---\n\n');

    const prompt = `Synthesize the following findings from ${agentOutputs.length} specialist agents into one consolidated report.

${findingsBlock}

Produce your synthesis report.`;

    const result = await callModelUltra(prompt, 'sonnet', SYNTHESIS_SYSTEM);

    return {
      output: { text: result.text, agentCount: agentOutputs.length },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
