import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import { getInnovationRadarFeedback } from '../../packages/core/src/task-queue.js';

type RadarFeedbackCode =
  | 'APPROVED'
  | 'REJECTED_IRRELEVANT'
  | 'REJECTED_NOT_NOVEL'
  | 'REJECTED_WEAK_EVIDENCE'
  | 'REJECTED_TOO_COSTLY'
  | 'REJECTED_NOT_NOW';

interface RadarFeedback {
  code?: string;
  opportunity?: string;
  notes?: string;
  trigger?: string;
}

const COMPETITIVE_INTEL_SYSTEM = `You are the Competitive Intelligence / Innovation Radar perspective for Organism.

Your purpose is to surface only the freshest, highest-leverage external changes that materially matter to the current project.

Operating stance:
- Start from internal project pain, bottlenecks, roadmap gaps, and user friction
- Then search for recent external changes that could help right now
- Prefer official docs, changelogs, release notes, papers, and vendor announcements as evidence
- Treat GitHub discussions, Reddit, X/Twitter, HN, and forums as weak discovery signals only
- Convert discoveries into bounded experiments with kill criteria

Autoresearch loop (mandatory):
1. Form 3-5 candidate hypotheses
2. Investigate each with real evidence
3. Try to disprove each one
4. Cross-check from a second angle
5. Discard weak or generic ideas
6. Report at most 3 surviving opportunities

Output format (strictly follow):
## Innovation Radar Brief

**Project:** [project]
**Focus:** [focus area or "General product leverage"]
**Decision:** APPROVED | NO_ACTION
**Why now:** [1-2 sentences]
**Feedback applied:** [how prior approval/rejection feedback changed this run, or "None"]

### Opportunity 1: [title]
- What changed: [recent launch, paper, release, behaviour shift, or tooling change]
- Why it matters here: [specific fit to this project]
- Evidence: [primary sources first; weak-signal sources may appear second]
- Effort: [S | M | L with one-sentence explanation]
- Risk: [main downside or failure mode]
- Suggested experiment: [bounded next step, 1-2 sentences]
- Kill criteria: [clear condition to stop]
- Confidence: [HIGH | MEDIUM]

### Opportunity 2: ...

### Opportunity 3: ...

**Next Review:** [days + reason]

Rules:
- Max 3 opportunities
- If none survive, output NO_ACTION and explain why
- No generic "AI could help" filler
- No recommendation without concrete evidence
- Do not create implementation tasks
- If prior feedback indicates irrelevance, weak evidence, lack of novelty, or timing mismatch, tighten your filter accordingly
- If evidence is missing, say so and discard the idea instead of bluffing`;

function normalizeFeedback(value: unknown): RadarFeedback[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is RadarFeedback => typeof item === 'object' && item !== null)
    .map((item) => ({
      code: typeof item.code === 'string' ? item.code : undefined,
      opportunity: typeof item.opportunity === 'string' ? item.opportunity : undefined,
      notes: typeof item.notes === 'string' ? item.notes : undefined,
      trigger: typeof item.trigger === 'string' ? item.trigger : undefined,
    }));
}

function mergeFeedback(...groups: RadarFeedback[][]): RadarFeedback[] {
  const seen = new Set<string>();
  const merged: RadarFeedback[] = [];

  for (const group of groups) {
    for (const entry of group) {
      const key = [
        entry.code ?? '',
        entry.opportunity ?? '',
        entry.notes ?? '',
        entry.trigger ?? '',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }

  return merged;
}

function summarizeFeedback(feedback: RadarFeedback[]): string {
  if (feedback.length === 0) return 'None';

  const counts = new Map<string, number>();
  for (const entry of feedback) {
    const code = entry.code ?? 'UNKNOWN';
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }

  const guidance: string[] = [];
  const count = (code: RadarFeedbackCode) => counts.get(code) ?? 0;

  if (count('REJECTED_IRRELEVANT') > 0) {
    guidance.push('Tighten project-fit filter and reject ideas that do not map to an active bottleneck.');
  }
  if (count('REJECTED_NOT_NOVEL') > 0) {
    guidance.push('Raise novelty threshold and avoid resurfacing ideas the project likely already knows.');
  }
  if (count('REJECTED_WEAK_EVIDENCE') > 0) {
    guidance.push('Require stronger primary evidence before recommending an idea.');
  }
  if (count('REJECTED_TOO_COSTLY') > 0) {
    guidance.push('Bias toward smaller experiments and lower implementation cost.');
  }
  if (count('REJECTED_NOT_NOW') > 0) {
    guidance.push('Suppress timing-mismatched ideas unless a trigger condition has changed.');
  }
  if (count('APPROVED') > 0) {
    guidance.push('Preserve the source and experiment patterns from previously approved ideas.');
  }

  const compactCounts = [...counts.entries()]
    .map(([code, total]) => `${code}:${total}`)
    .join(', ');

  return `${compactCounts}. Guidance: ${guidance.join(' ') || 'Use standard filters.'}`.trim();
}

export default class CompetitiveIntelAgent extends BaseAgent {
  constructor() {
    super({
      name: 'competitive-intel',
      model: 'sonnet',
      capability: {
        id: 'intel.competitive',
        owner: 'competitive-intel',
        collaborators: ['cto', 'product-manager'],
        reviewerLane: 'MEDIUM',
        description: 'Project-scoped innovation radar: surfaces recent external changes that map to current product bottlenecks, with evidence, bounded experiments, and kill criteria.',
        status: 'shadow',
        model: 'sonnet',
        frequencyTier: 'weekly',
        projectScope: 'all',
        knowledgeSources: ['knowledge/innovation/innovation-radar-playbook.md'],
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const project = (input?.project as string) ?? task.projectId ?? 'organism';
    const focus = Array.isArray(input?.focusAreas)
      ? (input.focusAreas as unknown[]).filter((item): item is string => typeof item === 'string').join(', ')
      : (input?.focusArea as string) ?? 'General product leverage';
    const maxOpportunities = Math.max(1, Math.min(3, Number(input?.maxOpportunities ?? 3) || 3));
    const manualFeedback = normalizeFeedback(input?.recentFeedback);
    const persistedFeedback = normalizeFeedback(getInnovationRadarFeedback(project, 12));
    const recentFeedback = mergeFeedback(manualFeedback, persistedFeedback);
    const feedbackSummary = summarizeFeedback(recentFeedback);

    const prompt = `Run an innovation radar pass for the following task.

Task: ${task.description}
Project: ${project}
Focus: ${focus}
Maximum opportunities to report: ${maxOpportunities}

Current context:
${JSON.stringify(input, null, 2)}

Recent feedback from prior radar runs:
${recentFeedback.length > 0 ? JSON.stringify(recentFeedback, null, 2) : '[]'}

Feedback summary:
${feedbackSummary}

Instructions:
- Investigate several candidate ideas but report only the survivors
- Apply the feedback summary as a hard filter for this run
- Prefer recent, sourceable changes over generic advice
- If nothing survives, output NO_ACTION
- Output the Innovation Radar Brief directly with no preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', COMPETITIVE_INTEL_SYSTEM);

    return {
      output: {
        text: result.text,
        project,
        focus,
        maxOpportunities,
        feedbackApplied: feedbackSummary,
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
