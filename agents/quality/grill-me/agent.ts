import { BaseAgent } from '../../_base/agent.js';
import { callModelUltra } from '../../_base/mcp-client.js';
import { Task } from '../../../packages/shared/src/types.js';
import { createTask } from '../../../packages/core/src/task-queue.js';

const GRILL_ME_SYSTEM = `You are Grill-Me — the Socratic interrogator for Organism. You do NOT execute tasks. You challenge assumptions.

Given a task about to be sent to another agent, you produce a scrutiny report:
1. Identify the core assumption behind the task
2. Find 2-3 blind spots (what is the description NOT saying)
3. Ask 3-5 hard questions that, if unanswered, will cause the wrong thing to be built
4. Assess whether the MEDIUM risk classification is correct
5. Give a verdict: CLEAR TO PROCEED | NEEDS CLARIFICATION | RECLASSIFY AS HIGH

Output format:
## Grill-Me Interrogation

**Task:** [one line]
**Intended agent:** [agent name]
**Verdict:** CLEAR TO PROCEED | NEEDS CLARIFICATION | RECLASSIFY AS HIGH

### Core assumption
[one sentence]

### Blind spots
- [blind spot]
- [blind spot]

### Hard questions
1. [Specific question — not generic]
2. [Specific question]
3. [Specific question]

### Risk assessment
[Is MEDIUM correct? One sentence.]

### Guidance for the executing agent
[2-3 sentences of specific, actionable guidance]

Rules: Be specific. Maximum 400 words. Never answer the hard questions yourself.`;

export default class GrillMeAgent extends BaseAgent {
  constructor() {
    super({
      name: 'grill-me',
      model: 'sonnet',
      capability: {
        id: 'quality.interrogation',
        owner: 'grill-me',
        collaborators: [],
        reviewerLane: 'LOW',
        description: 'Socratic interrogation of decisions — challenges assumptions and blind spots',
        status: 'shadow',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const intendedAgent = (input?.intendedAgent as string) ?? 'ceo';
    const originalDescription = (input?.originalDescription as string) ?? task.description;
    const originalInput = input?.originalInput ?? {};
    const projectId = task.projectId;

    const prompt = `Interrogate the following task before it is sent to the "${intendedAgent}" agent.

Task description: ${originalDescription}

Task input:
${JSON.stringify(originalInput, null, 2)}

Apply the Socratic method. Produce your scrutiny report.`;

    const result = await callModelUltra(prompt, 'sonnet', GRILL_ME_SYSTEM);

    const shouldReclassify = result.text.includes('RECLASSIFY AS HIGH');
    const needsClarification = result.text.includes('NEEDS CLARIFICATION');
    const verdict = shouldReclassify ? 'RECLASSIFY_HIGH' : needsClarification ? 'NEEDS_CLARIFICATION' : 'CLEAR';

    // Create the real task for the intended agent, with Grill-Me's scrutiny attached
    const realTaskLane = shouldReclassify ? 'HIGH' : 'MEDIUM';

    if (!shouldReclassify) {
      // Proceed — create the task for the intended agent with scrutiny attached
      createTask({
        agent: intendedAgent,
        lane: realTaskLane,
        description: originalDescription,
        input: {
          ...originalInput as Record<string, unknown>,
          grillMeScrutiny: result.text,
          grillMeVerdict: verdict,
        },
        parentTaskId: task.id,
        projectId,
      });
    } else {
      // Reclassify — create HIGH-risk task routed through the full pipeline
      // For now, create the task at HIGH lane for CEO to handle re-routing
      createTask({
        agent: 'ceo',
        lane: 'HIGH',
        description: `[RECLASSIFIED HIGH] ${originalDescription}`,
        input: {
          ...originalInput as Record<string, unknown>,
          grillMeScrutiny: result.text,
          reclassifiedFrom: 'MEDIUM',
          originalAgent: intendedAgent,
        },
        parentTaskId: task.id,
        projectId,
      });
    }

    return {
      output: {
        scrutiny: result.text,
        verdict,
        intendedAgent,
        reclassified: shouldReclassify,
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
