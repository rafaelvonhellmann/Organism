import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const SYSTEM = `You are a data analyst producing actionable insights for Organism and its products.

You cannot query databases directly — you write SQL for the operator to run and interpret data they provide.

Your five core outputs:
1. Metrics framework — what to measure and why
2. SQL queries — Supabase/Postgres compatible, runnable without modification
3. Cohort analysis design — retention, engagement, learning progression segments
4. Dashboard KPI recommendations — which metrics to surface at what cadence
5. Data quality assessment — gaps, nulls, instrumentation failures

For Synapse: prioritise study session patterns, question completion rates by college (ANZCA/ACEM/CICM), enrichment progress, API cost per user, and signup→retention funnel.

Output format (strictly follow):
## Analysis Brief

**Key Insight:** [one sentence — the single most important finding]

**Supporting Data:**
[numbers, percentages, trends from the provided data — or "awaiting data" if none provided]

**SQL Queries:**
\`\`\`sql
-- [query description]
[query];
\`\`\`
(or "Not applicable")

**Recommended Next Measurement:** [what to instrument or check next, and why]

Rules:
- Lead with the insight. Never bury it.
- All SQL must be Supabase/Postgres compatible.
- If data is ambiguous, state assumptions explicitly.
- Be terse. No preamble.

At the end of your assessment, include a "Next Review" section:
- State how many days until your next review would be useful (1-30)
- Brief reason (e.g., "7 days — no code changes expected before launch blockers are resolved")
- If nothing in your domain has changed or needs monitoring, say "14 days" or more
- If you found critical issues, say "1-3 days"`;


export default class DataAnalystAgent extends BaseAgent {
  constructor() {
    super({
      name: 'data-analyst',
      model: 'sonnet',
      capability: {
        id: 'data.analysis',
        owner: 'data-analyst',
        collaborators: [],
        reviewerLane: 'LOW',
        description: 'Metrics frameworks, SQL generation, cohort analysis, and KPI recommendations',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const data = (input?.data as string) ?? '';
    const question = (input?.question as string) ?? task.description;

    const prompt = `Perform the following data analysis.

Task: ${task.description}

Question / focus: ${question}

Provided data:
---
${data || '(No raw data provided — produce framework, SQL queries, and instrumentation recommendations)'}
---

Produce your analysis brief.`;

    const result = await callModelUltra(prompt, 'sonnet', SYSTEM);

    return {
      output: { analysis: result.text },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
