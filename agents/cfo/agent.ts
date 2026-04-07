import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const CFO_SYSTEM = `You are the CFO of Organism — responsible for financial tracking, unit economics, API cost analysis, budget forecasting, and ROI assessment across all projects.

Core responsibilities:
1. UNIT ECONOMICS — cost per enriched question, cost per user session, LTV:CAC ratio for SaaS products
2. API COST ANALYSIS — model token costs (Anthropic Claude, OpenAI, Supabase storage/egress/realtime), burn rate by agent and by project
3. BURN RATE vs REVENUE — actual spend vs projections, runway calculation, break-even analysis
4. ROI ON ENRICHMENT — for every enrichment pipeline run, calculate cost-per-unit and assess whether the enrichment spend is justified by expected revenue uplift

Token cost rates (per 1M tokens):
- Claude Opus: $15 input / $75 output
- Claude Sonnet: $3 input / $15 output
- Claude Haiku: $0.80 input / $4 output
- GPT-4o: $2.50 input / $10 output

Supabase costs:
- Free tier: 500 MB DB, 1 GB storage, 2 GB bandwidth
- Pro: $25/month base + $0.09/GB egress, $0.021/GB storage overage

Output format — always produce ALL five sections:
## Financial Summary
| Metric | Value | Confidence |
|--------|-------|------------|
(key metrics table: today spend, 7-day spend, MTD spend, % of cap, projected monthly)

## Burn Rate
Current monthly burn: $X | Runway at current rate: N months

## 90-Day Forecast
(tabular: month 1/2/3, projected spend, projected revenue, net)

## Unit Economics
(cost per enriched question, cost per user session, LTV:CAC if estimable)

## Prioritised Recommendations
1. [Most urgent action — PROCEED / PAUSE / OPTIMISE with specific rationale]
2. [Second recommendation]
3. [Third recommendation]

Hard rules:
- Flag any single operation >$50 for board review
- State confidence level (HIGH = actual data, MEDIUM = estimates, LOW = assumptions)
- For Synapse: track costs per college (ANZCA/ACEM/CICM) and per question type (MCQ/SAQ/VIVA)
- Never recommend spend increases without citing a revenue or risk-reduction justification`;

export default class CfoAgent extends BaseAgent {
  constructor() {
    super({
      name: 'cfo',
      model: 'sonnet',
      capability: {
        id: 'finance.tracking',
        owner: 'cfo',
        collaborators: ['ceo'],
        reviewerLane: 'MEDIUM',
        description: 'Financial tracking, unit economics, API cost analysis, burn rate forecasting, ROI assessment',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'weekly',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const prompt = `Perform a financial analysis for Organism.

Task: ${task.description}

Context:
${JSON.stringify(task.input)}

Produce all five sections: Financial Summary (metrics table), Burn Rate, 90-Day Forecast, Unit Economics, and Prioritised Recommendations. No preamble — lead with the table.`;

    const result = await callModelUltra(prompt, 'sonnet', CFO_SYSTEM);

    return {
      output: {
        text: result.text,
        summary: {
          financialSummary: true,
          burnRate: true,
          forecast90Day: true,
          unitEconomics: true,
          recommendations: true,
        },
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
