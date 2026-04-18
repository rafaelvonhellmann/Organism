import { BaseAgent } from '../../_base/agent.js';
import { callNativeModel } from '../../_base/mcp-client.js';
import { Task } from '../../../packages/shared/src/types.js';
import { getTask } from '../../../packages/core/src/task-queue.js';

const CODEX_REVIEW_MODEL = 'gpt5.4';
const CODEX_REVIEW_MAX_COMPLETION_TOKENS = 1600;

const CODEX_REVIEW_SYSTEM = `You are a senior engineering reviewer on Organism's dedicated OpenAI review lane. You review code and agent outputs from a different perspective to catch what the primary implementation pass missed.

For every review, check:
1. **Logic errors** — off-by-one, wrong conditionals, missing null checks, unreachable code
2. **Security issues (OWASP Top 10)** — injection, broken auth, sensitive data exposure, XXE, broken access control, security misconfiguration, XSS, insecure deserialization, known-vuln components, insufficient logging
3. **Edge cases** — empty inputs, concurrent access, max payload sizes, encoding issues, time zone bugs
4. **Performance** — N+1 queries, blocking I/O in hot paths, missing indexes, unbound loops

Output exactly this format:

## Codex Review

**Decision:** APPROVED | NEEDS_REVISION

**Summary:** [One sentence — overall quality verdict]

### Issues

| # | Severity | Category | Location | Description | Suggested Fix |
|---|----------|----------|----------|-------------|---------------|
| 1 | CRITICAL/HIGH/MEDIUM/LOW | [Logic/Security/EdgeCase/Performance] | [line/function/area] | [description] | [fix] |

*(If no issues: "No issues found.")*

### Notes
[Any observations that are not blocking but worth knowing. Max 3 bullets.]

Rules:
- NEEDS_REVISION only if CRITICAL or HIGH severity issues exist.
- Be specific. "Could be better" is not a finding. Line numbers or function names required.
- Maximum 400 words.`;

function remediationWorkflowKind(task: Task | null): 'implement' | 'validate' {
  if (!task) return 'implement';
  if (task.workflowKind === 'validate' || task.workflowKind === 'review' || task.workflowKind === 'plan') {
    return 'implement';
  }
  return 'validate';
}

function describeOpenAiLaneError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unauthorized|401|403|login/i.test(message)) {
    return `OpenAI lane authentication failed: ${message}`;
  }
  if (/rate limit|429|quota|billing|credit balance is too low|insufficient/i.test(message)) {
    return `OpenAI lane capacity error: ${message}`;
  }
  if (/fetch failed|connection error|network error|timed out|timeout/i.test(message)) {
    return `OpenAI lane transport error: ${message}`;
  }
  return `OpenAI lane error: ${message}`;
}

export default class CodexReviewAgent extends BaseAgent {
  constructor() {
    super({
      name: 'codex-review',
      model: 'gpt5.4',
      capability: {
        id: 'quality.codex_review',
        owner: 'codex-review',
        collaborators: [],
        reviewerLane: 'MEDIUM',
        description: 'OpenAI review lane for logic, security, edge cases, and performance blind-spot coverage',
        status: 'shadow',
        model: 'gpt5.4',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const originalOutput = (input?.output as string) ?? '';
    const originalDesc = (input?.originalDescription as string) ?? task.description;
    const originalTaskId = (input?.originalTaskId as string) ?? '';
    const parentTask = originalTaskId ? getTask(originalTaskId) : null;

    const prompt = `Review the following agent output for the task described.

Original task: ${originalDesc}

Output to review:
---
${originalOutput}
---

Apply your code and quality review checklist. Produce the structured review.`;

    let result;
    try {
      result = await callNativeModel(prompt, CODEX_REVIEW_MODEL, CODEX_REVIEW_SYSTEM, CODEX_REVIEW_MAX_COMPLETION_TOKENS);
    } catch (error) {
      throw new Error(describeOpenAiLaneError(error));
    }

    const approved = result.text.includes('**Decision:** APPROVED')
      || result.text.includes('Decision: APPROVED');

    return {
      output: {
        review: result.text,
        decision: approved ? 'APPROVED' : 'NEEDS_REVISION',
        originalTaskId,
        skipped: false,
        handoffRequests: !approved && parentTask
          ? [
              {
                id: `codex-revision-${task.id}`,
                targetAgent: parentTask.agent,
                workflowKind: remediationWorkflowKind(parentTask),
                reason: 'Codex review identified issues that need another bounded implementation pass.',
                summary: `Address codex-review findings for "${parentTask.description.slice(0, 80)}"`,
                execution: parentTask.agent === 'engineering',
              },
            ]
          : [],
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
