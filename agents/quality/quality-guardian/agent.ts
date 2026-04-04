import { BaseAgent } from '../../_base/agent.js';
import { callModelUltra } from '../../_base/mcp-client.js';
import { Task } from '../../../packages/shared/src/types.js';

const GUARDIAN_SYSTEM = `You are the Quality Guardian for Organism — the deepest, most thorough quality audit in the pipeline. You run on Opus. You are the last line of defence before G4 board review.

You perform a 6-phase audit using autoresearch methodology. For every potential issue you find at least 2 independent confirming signals before reporting it. LOW confidence findings are discarded.

## Phase 1 — Baseline
Establish what was expected. Restate the original task and success criteria.

## Phase 2 — Multi-angle audit
Examine the output from 6 angles:
1. Data integrity — is the content accurate, complete, consistent?
2. Derived outputs — do generated artefacts match their source inputs?
3. Feature completeness — does output address every part of the task?
4. Security & compliance — OWASP Top 10, data exposure, auth issues
5. User impact — does the output serve the actual user's need?
6. Organism invariants — does this output violate any system-level rules?

## Phase 3 — Browser / integration verification
Note any external checks that WOULD be run in active mode (Playwright, API calls). In shadow mode, describe them but do not execute.

## Phase 4 — Cross-validation
Do findings from different angles corroborate each other? Are issues systemic or isolated?

## Phase 5 — Root cause analysis
For each confirmed issue: What → Why (root cause chain) → Impact → Best fix (with 2 alternatives considered).

## Phase 6 — Act (SKIPPED IN SHADOW MODE)
In active mode: auto-fix safe issues, propose others for approval. In shadow mode: list what WOULD be done but take no action.

## Output format

\`\`\`
## Quality Guardian Report — [task-id] — [SHADOW MODE | ACTIVE]

### Platform Health Score: X/100

### Issues Found
| # | Severity | Area | Issue | Evidence | Confidence | Best Fix |
|---|----------|------|-------|----------|------------|----------|

### Phase 6 — Act
[SHADOW MODE: What would be done | ACTIVE: What was done]

### Auto-Fix Proposals (shadow mode — not executed)
| # | Issue | Proposed action | Risk | Effort |
|---|-------|----------------|------|--------|

### Needs Board Approval
| # | Issue | Proposed fix | Risk | Effort |
|---|-------|-------------|------|--------|

### Metrics
- Areas audited: N
- Issues: X critical, Y high, Z medium
- Confidence: HIGH/MEDIUM only
- Shadow mode: [yes/no]
\`\`\`

Hard rules:
- Never report LOW confidence. Investigate more or discard.
- Never delete data or push code in shadow mode.
- Be terse. Findings → evidence → fix. No padding.`;

export default class QualityGuardianAgent extends BaseAgent {
  constructor() {
    super({
      name: 'quality-guardian',
      model: 'opus',
      capability: {
        id: 'quality.deep_audit',
        owner: 'quality-guardian',
        collaborators: [],
        reviewerLane: 'HIGH',
        description: 'Opus-powered 6-phase deep audit — Platform Health Score, root cause analysis, auto-fix proposals',
        status: 'shadow',
        model: 'opus',
        frequencyTier: 'weekly',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const originalOutput = (input?.output as string) ?? '';
    const originalDesc = (input?.originalDescription as string) ?? task.description;
    const originalTaskId = (input?.originalTaskId as string) ?? '';

    const shadowMode = process.env['SHADOW_MODE'] === 'true' ||
                       this.config.capability.status === 'shadow';

    const prompt = `Perform a full 6-phase Quality Guardian audit on the following output.

${shadowMode ? 'SHADOW MODE: Run all phases but SKIP Phase 6 (Act). Describe what you would do but take no action.' : 'ACTIVE MODE: Complete all 6 phases including Phase 6 (Act).'}

Original task: ${originalDesc}
Task ID: ${originalTaskId}

Output under review:
---
${originalOutput}
---

Additional context:
${JSON.stringify({ ...input, output: undefined }, null, 2)}

Apply the 6-phase audit. Produce the structured Quality Guardian Report. Begin directly with the report.`;

    const result = await callModelUltra(prompt, 'opus', GUARDIAN_SYSTEM);

    const healthScoreMatch = result.text.match(/Platform Health Score:\s*(\d+)/);
    const healthScore = healthScoreMatch ? parseInt(healthScoreMatch[1], 10) : null;

    const criticalIssues = (result.text.match(/\|\s*CRITICAL\s*\|/g) ?? []).length;
    const approved = criticalIssues === 0 && (healthScore ?? 0) >= 70;

    return {
      output: {
        report: result.text,
        healthScore,
        decision: approved ? 'APPROVED' : 'NEEDS_REVISION',
        shadowMode,
        originalTaskId,
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
