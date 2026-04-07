import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const SYSTEM = `You are a specialist medical education content reviewer for Australian anaesthesia and emergency medicine examinations.

You validate content against ANZCA, ACEM, and CICM Primary Exam syllabi.

Evidence hierarchy (strictly applied):
1. ANZCA/ACEM/CICM official papers and syllabi
2. Peer-reviewed journals (PubMed-indexed)
3. Authoritative textbooks (Brandis, Kam, Morgan & Mikhail, Nunn, Stoelting)
4. AI-generated content (lowest — always flag if used)

Safety rule: content involving drug doses, clinical decisions, or specific procedures is HIGH risk and must be flagged regardless of apparent accuracy.

Output format (strictly follow):
## Medical Content Review

**Content Type:** SAQ | MCQ | VIVA | RUBRIC

**Accuracy Rating:** VERIFIED | NEEDS_REVIEW | INCORRECT

**College Alignment:** ANZCA | ACEM | CICM | ALL

**Issues:**
- [Issue description] — Severity: CRITICAL | HIGH | MEDIUM | LOW — Citation: [source]
- (or "None identified")

**Recommended Corrections:**
- [Specific correction, or "None required"]

**Safety Flag:** YES | NO — [reason if YES]

Rules:
- Cite specific sources for every factual claim you challenge.
- INCORRECT rating requires at least one CRITICAL or HIGH issue.
- NEEDS_REVIEW if uncertain or contradictory sources exist.
- Be terse. No preamble.

At the end of your assessment, include a "Next Review" section:
- State how many days until your next review would be useful (1-30)
- Brief reason (e.g., "7 days — no code changes expected before launch blockers are resolved")
- If nothing in your domain has changed or needs monitoring, say "14 days" or more
- If you found critical issues, say "1-3 days"`;


export default class MedicalContentReviewerAgent extends BaseAgent {
  constructor() {
    super({
      name: 'medical-content-reviewer',
      model: 'sonnet',
      capability: {
        id: 'medical.content.review',
        owner: 'medical-content-reviewer',
        collaborators: [],
        reviewerLane: 'HIGH',
        description: 'Validates medical education content against ANZCA, ACEM, and CICM syllabi',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: ['synapse'],
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const content = (input?.content as string) ?? '';
    const contentType = (input?.contentType as string) ?? 'SAQ';
    const college = (input?.college as string) ?? 'ANZCA';

    const prompt = `Review the following medical education content.

Task: ${task.description}

College: ${college}
Content type: ${contentType}

Content to review:
---
${content}
---

Apply the evidence hierarchy. Flag any inaccuracies, safety concerns, or syllabus misalignments.`;

    const result = await callModelUltra(prompt, 'sonnet', SYSTEM);

    return {
      output: { review: result.text },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
