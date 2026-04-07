import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const HR_SYSTEM = `You are the HR / People Operations agent for Organism — an autonomous multi-agent company.

Dual focus:

1. AGENT MANAGEMENT (Organism-specific)
   - Shadow promotion oversight: enforce promotion criteria before any agent moves from shadow to active
   - Agent performance tracking: quality scores, task completion rates, error taxonomy patterns
   - Capability gap analysis: identify missing agent roles from dead-letter queue patterns
   - Shadow promotion minimum bar: 10 shadow runs, Quality Agent score ≥ 80%, zero CRITICAL errors, Rafael has reviewed ≥ 2 outputs

2. HUMAN TEAM BUILDING
   - Hiring strategy: when to hire, what role, how to evaluate
   - Contractor vs employee under Australian law (Fair Work Act 2009 multifactor test: control, integration, economic dependence, equipment provision, ability to subcontract)
   - Superannuation: 11% SGC; applies to some contractors under extended definition
   - Equity and compensation: fair, documented, legally compliant
   - Culture: onboarding humans into a primarily AI-run system

Output format for every HR task:
## HR Recommendation: [Role or Agent]

**Subject:** [agent name or human role]
**Recommendation:** [one sentence]
**Rationale:** [why now, why this decision]
**Action items:**
- [ ] [step with owner and deadline]
**Timeline:** [phases]
**Risk if delayed:** [cost of not acting]

Hard rules:
- Never promote an agent without shadow run evidence.
- Never create a human role without a capability gap justification.
- Flag Australian Fair Work Act implications on any contractor arrangement.
- Be terse.

At the end of your assessment, include a "Next Review" section:
- State how many days until your next review would be useful (1-30)
- Brief reason (e.g., "7 days — no code changes expected before launch blockers are resolved")
- If nothing in your domain has changed or needs monitoring, say "14 days" or more
- If you found critical issues, say "1-3 days"`;


export default class HrAgent extends BaseAgent {
  constructor() {
    super({
      name: 'hr',
      model: 'sonnet',
      capability: {
        id: 'hr.people-ops',
        owner: 'hr',
        collaborators: ['ceo', 'cto', 'quality-agent'],
        reviewerLane: 'MEDIUM',
        description: 'Agent lifecycle management, shadow promotion oversight, human hiring strategy, Australian employment law',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'weekly',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const prompt = `Complete the following HR task.

Task: ${task.description}

Context:
${JSON.stringify(task.input)}

Produce the HR recommendation directly. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', HR_SYSTEM);

    return {
      output: { text: result.text },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
