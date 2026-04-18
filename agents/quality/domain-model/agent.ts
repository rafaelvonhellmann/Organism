import { BaseAgent, type AgentConfig } from '../../_base/agent.js';
import { callModelUltra } from '../../_base/mcp-client.js';
import { Task } from '../../../packages/shared/src/types.js';
import { createTask, getSiblingTaskOutputs } from '../../../packages/core/src/task-queue.js';

const DOMAIN_MODEL_SYSTEM = `You are Domain Model — Organism's domain-shaping reviewer inspired by Matt Pocock's /domain-model workflow.

You do NOT execute the task. You pressure-test the problem framing before execution.

Your job:
1. Restate the real problem in domain language
2. Surface the ubiquitous language that should be used consistently
3. Identify the likely bounded contexts, aggregates, entities, value objects, invariants, and domain events
4. Find 2-3 blind spots that could cause the wrong thing to be built
5. Ask 3-5 hard questions that must be answered before execution
6. Recommend docs and ADR updates that should happen as part of the work
7. Assess whether the current risk classification is right
8. Give a verdict: CLEAR TO PROCEED | NEEDS CLARIFICATION | RECLASSIFY AS HIGH

Output format:
## Domain Model Review

**Task:** [one line]
**Intended agent:** [agent name]
**Verdict:** CLEAR TO PROCEED | NEEDS CLARIFICATION | RECLASSIFY AS HIGH

### Domain framing
[short explanation of the real domain problem]

### Ubiquitous language
- [term] — [shared meaning]

### Bounded contexts and model candidates
- **Context:** [name]
  **Aggregates / entities / value objects:** [compact list]

### Invariants and domain events
- [important invariant or event]

### Blind spots
- [blind spot]

### Hard questions
1. [specific question]
2. [specific question]
3. [specific question]

### ADRs to capture
- [ADR title]

### Docs to update
- [doc, tasklist, wiki, or README to update]

### Guidance for the executing agent
[2-4 sentences of practical guidance]

Rules:
- Be specific and grounded in the task.
- Never answer the hard questions yourself.
- Prefer concise, implementation-shaping language over abstract theory.
- Maximum 700 words total.`;

function extractBulletSection(report: string, heading: string): string[] {
  const headingPattern = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = report.match(new RegExp(`### ${headingPattern}\\s*\\n([\\s\\S]*?)(?=\\n### |$)`, 'i'));
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter((line) => line.length > 0);
}

type DomainModelVerdict = 'CLEAR' | 'NEEDS_CLARIFICATION' | 'RECLASSIFY_HIGH';

export class DomainModelAgent extends BaseAgent {
  constructor(configOverrides: Partial<AgentConfig> = {}) {
    super({
      name: 'domain-model',
      registryOwner: 'domain-model',
      model: 'haiku',
      capability: {
        id: 'quality.domain_model',
        owner: 'domain-model',
        collaborators: [],
        reviewerLane: 'LOW',
        description: 'Domain modeling review — adds DDD framing, ADR candidates, and docs guidance before execution',
        status: 'shadow',
        model: 'haiku',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
      ...configOverrides,
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const intendedAgent = (input?.intendedAgent as string) ?? 'ceo';
    const originalDescription = (input?.originalDescription as string) ?? task.description;
    const originalInput = input?.originalInput ?? {};
    const projectId = task.projectId;

    const prompt = `Review the following task before it is sent to the "${intendedAgent}" agent.

Task description: ${originalDescription}

Task input:
${JSON.stringify(originalInput)}

Apply domain-model thinking with practical DDD concepts. Produce the review directly.`;

    const result = await callModelUltra(prompt, 'haiku', DOMAIN_MODEL_SYSTEM);
    const text = result.text;

    const verdict: DomainModelVerdict = text.includes('RECLASSIFY AS HIGH')
      ? 'RECLASSIFY_HIGH'
      : text.includes('NEEDS CLARIFICATION')
        ? 'NEEDS_CLARIFICATION'
        : 'CLEAR';

    const domainModelArtifacts = {
      review: text,
      verdict,
      adrCandidates: extractBulletSection(text, 'ADRs to capture'),
      docsToUpdate: extractBulletSection(text, 'Docs to update'),
      ubiquitousLanguage: extractBulletSection(text, 'Ubiquitous language'),
      invariantsAndEvents: extractBulletSection(text, 'Invariants and domain events'),
      blindSpots: extractBulletSection(text, 'Blind spots'),
    };

    const realTaskLane = verdict === 'RECLASSIFY_HIGH' ? 'HIGH' : 'MEDIUM';

    let relatedFindings: Array<{ agent: string; description: string; outputSummary: string }> = [];
    if (task.parentTaskId) {
      try {
        relatedFindings = getSiblingTaskOutputs(task.parentTaskId, task.id);
      } catch {
        // Non-critical: sibling findings are optional context.
      }
    }

    const forwardedInput = {
      ...(originalInput as Record<string, unknown>),
      domainModelReview: text,
      domainModelVerdict: verdict,
      domainModelArtifacts,
      adrCandidates: domainModelArtifacts.adrCandidates,
      docsToUpdate: domainModelArtifacts.docsToUpdate,
      grillMeScrutiny: text,
      grillMeVerdict: verdict,
      ...(relatedFindings.length > 0 ? { relatedFindings } : {}),
    };

    if (verdict !== 'RECLASSIFY_HIGH') {
      createTask({
        agent: intendedAgent,
        lane: realTaskLane,
        description: originalDescription,
        input: forwardedInput,
        parentTaskId: task.id,
        projectId,
      });
    } else {
      createTask({
        agent: intendedAgent,
        lane: 'HIGH',
        description: `[RECLASSIFIED HIGH] ${originalDescription}`,
        input: {
          ...forwardedInput,
          reclassifiedFrom: 'MEDIUM',
        },
        parentTaskId: task.id,
        projectId,
      });
    }

    return {
      output: {
        review: text,
        verdict,
        intendedAgent,
        reclassified: verdict === 'RECLASSIFY_HIGH',
        domainModelArtifacts,
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}

export class LegacyGrillMeAliasAgent extends DomainModelAgent {
  constructor() {
    super({
      name: 'grill-me',
      registryOwner: 'domain-model',
      capability: {
        id: 'quality.domain_model',
        owner: 'domain-model',
        collaborators: [],
        reviewerLane: 'LOW',
        description: 'Legacy alias for Domain Model review',
        status: 'shadow',
        model: 'haiku',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }
}

export default DomainModelAgent;
