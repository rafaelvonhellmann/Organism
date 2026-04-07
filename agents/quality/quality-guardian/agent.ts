import { BaseAgent } from '../../_base/agent.js';
import { callModelUltra } from '../../_base/mcp-client.js';
import { Task } from '../../../packages/shared/src/types.js';
import { getTask, createTask } from '../../../packages/core/src/task-queue.js';

const GUARDIAN_SYSTEM = `You are the Quality Guardian for Organism — the deepest, most thorough quality audit in the pipeline. You are the last line of defence before G4 board review.

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
      model: 'sonnet',
      capability: {
        id: 'quality.deep_audit',
        owner: 'quality-guardian',
        collaborators: [],
        reviewerLane: 'HIGH',
        description: '6-phase deep audit — Platform Health Score, root cause analysis, auto-fix proposals',
        status: 'shadow',
        model: 'sonnet',
        frequencyTier: 'weekly',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const rawOutput = (input?.output as string) ?? '';
    const originalOutput = rawOutput.slice(0, 8000); // Cap at ~2K tokens to control cost
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
${JSON.stringify({ ...input, output: undefined })}

Apply the 6-phase audit. Produce the structured Quality Guardian Report. Begin directly with the report.`;

    const result = await callModelUltra(prompt, 'sonnet', GUARDIAN_SYSTEM);

    const healthScoreMatch = result.text.match(/Platform Health Score:\s*(\d+)/);
    const healthScore = healthScoreMatch ? parseInt(healthScoreMatch[1], 10) : null;

    const criticalIssues = (result.text.match(/\|\s*CRITICAL\s*\|/g) ?? []).length;
    const approved = criticalIssues === 0 && (healthScore ?? 0) >= 70;

    // Quality feedback loop: if guardian finds CRITICAL issues, create a revision
    // task for the original agent so it can address the feedback.
    if (!approved && originalTaskId && criticalIssues > 0) {
      const parentTask = getTask(originalTaskId);
      if (parentTask) {
        try {
          createTask({
            agent: parentTask.agent,
            lane: 'LOW',
            description: `Revision needed: Quality Guardian flagged ${criticalIssues} critical issue(s) in "${parentTask.description.slice(0, 80)}"`,
            input: {
              qualityFeedback: result.text,
              originalTaskId,
              originalDescription: parentTask.description,
            },
            parentTaskId: originalTaskId,
            projectId: parentTask.projectId ?? 'organism',
          });
          console.log(`[quality-guardian] Revision task created for '${parentTask.agent}' (original task ${originalTaskId})`);
        } catch {
          console.warn(`[quality-guardian] Could not create revision task for ${originalTaskId}`);
        }
      }
    }

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
