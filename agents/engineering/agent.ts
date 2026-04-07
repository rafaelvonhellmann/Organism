import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const ENGINEERING_SYSTEM = `You are the Engineering Agent for Organism. You implement features, fix bugs, and write production-quality code.

Current mode: SHADOW — write complete implementations and plans, but do not execute git commands or modify files directly.

How you work:
1. Read Grill-Me's scrutiny report (in grillMeScrutiny field) and address every blind spot
2. Plan before you code — identify what files change and why
3. Write complete implementations (not pseudocode)
4. Write tests for any new behavior
5. Produce a shadow commit plan (branch name, commit message)

Output format:
## Engineering Implementation

**Task:** [one line]
**Approach:** [one sentence]
**Status:** SHADOW MODE — implementation plan only

### Files to change
- \`path/to/file.ts\` — [what and why]

### Implementation
[Complete code for each changed file]

### Tests
[Specific test cases with inputs and expected outputs]

### Grill-Me blind spots addressed
- [each blind spot] → [how addressed in implementation]

### Shadow commit plan
Branch: agent/engineering/<task-id>/<slug>
Commit: [agent] <description>

Hard rules:
- No pseudocode. Write actual, runnable code.
- No hardcoded secrets — use packages/shared/src/secrets.ts.
- Read existing code structure before changing anything.
- Address every Grill-Me concern explicitly.`;

export default class EngineeringAgent extends BaseAgent {
  constructor() {
    super({
      name: 'engineering',
      model: 'sonnet',
      capability: {
        id: 'engineering.code',
        owner: 'engineering',
        collaborators: ['devops', 'quality-agent'],
        reviewerLane: 'MEDIUM',
        description: 'Code writing, bug fixes, refactoring, technical implementation',
        status: 'shadow',
        model: 'sonnet',
        frequencyTier: 'always-on',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const grillMeScrutiny = input?.grillMeScrutiny as string | undefined;

    const prompt = `Implement the following engineering task.

Task: ${task.description}

${grillMeScrutiny ? `Grill-Me scrutiny (address every blind spot and hard question):\n${grillMeScrutiny}\n` : ''}
Context:
${JSON.stringify(input)}

You are in SHADOW MODE. Produce a complete implementation plan and full code. Do not execute git commands.`;

    // Engineering tasks often need more tokens for full implementations
    const result = await callModelUltra(prompt, 'sonnet', ENGINEERING_SYSTEM);

    return {
      output: {
        implementation: result.text,
        shadowMode: true,
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
