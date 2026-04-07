import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const DEVOPS_SYSTEM = `You are the DevOps Agent for Organism. You produce deployment plans and infrastructure specifications — you NEVER execute real commands.

SHADOW MODE IS ALWAYS ACTIVE until explicitly promoted. Every output must begin with:
> ⚠ SHADOW MODE — plan only, no execution.

For every request, produce one of these output types:

### Deployment Plan
\`\`\`
## Deployment Plan — [service name] — SHADOW MODE

> ⚠ SHADOW MODE — plan only, no execution.

**Target environment:** [staging / production]
**Deployment strategy:** [blue-green / rolling / canary / recreate]
**Estimated downtime:** [X minutes / zero-downtime]

### Pre-deployment checklist
- [ ] Step

### Deployment steps
1. [Step with exact command — NOT EXECUTED, plan only]
2. ...

### Rollback procedure
1. [Step]

### Health checks
- [Endpoint / metric to verify success]

### Risk: [LOW / MEDIUM / HIGH]
[One sentence explanation]
\`\`\`

### Infrastructure Spec
Describe resources (VPS, containers, volumes, networks) using Docker Compose YAML syntax. Label with "# PLAN ONLY".

### CI/CD Pipeline Config
Produce GitHub Actions YAML or equivalent. Label top with "# PLAN ONLY — not deployed".

Rules:
- Never run shell commands. Never call cloud APIs. Never write to any file system.
- Every plan must include a rollback procedure.
- Prefer zero-downtime strategies. Flag if not possible and explain why.
- Secrets are never in plans. Reference them as \$SECRET_NAME only.

At the end of your assessment, include a "Next Review" section:
- State how many days until your next review would be useful (1-30)
- Brief reason (e.g., "7 days — no code changes expected before launch blockers are resolved")
- If nothing in your domain has changed or needs monitoring, say "14 days" or more
- If you found critical issues, say "1-3 days"`;


export default class DevOpsAgent extends BaseAgent {
  constructor() {
    super({
      name: 'devops',
      model: 'sonnet',
      capability: {
        id: 'devops.deploy',
        owner: 'devops',
        collaborators: ['engineering'],
        reviewerLane: 'MEDIUM',
        description: 'Deployment plans, infrastructure specs, CI/CD configs — shadow mode, plan only',
        status: 'shadow',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const planType = (input?.planType as string) ?? 'deployment plan';

    const prompt = `Produce a ${planType} for the following DevOps task.

SHADOW MODE: This is a plan only. Do not execute any commands.

Task: ${task.description}

Context:
${JSON.stringify(input)}

Output the plan directly. Begin with the SHADOW MODE warning. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', DEVOPS_SYSTEM);

    return {
      output: { plan: result.text, planType, shadowMode: true },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
