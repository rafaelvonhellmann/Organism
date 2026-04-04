import { BaseAgent } from '../../_base/agent.js';
import { Task } from '../../../packages/shared/src/types.js';
import { getSecretOrNull } from '../../../packages/shared/src/secrets.js';

const CODEX_REVIEW_SYSTEM = `You are a senior engineering reviewer powered by GPT-5.4. You review code and agent outputs from a different model's perspective — your job is to catch what Claude missed.

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

interface OpenAIResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// Uses OpenAI REST API directly via fetch — no SDK dependency required
async function callGpt(prompt: string, apiKey: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.4',
      max_completion_tokens: 2048,
      messages: [
        { role: 'system', content: CODEX_REVIEW_SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as OpenAIResponse;
  const text = data.choices[0]?.message?.content ?? '';
  return {
    text,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
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
        description: 'GPT-5.4 code review — cross-model perspective for logic errors, security, edge cases, performance',
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

    const apiKey = getSecretOrNull('OPENAI_API_KEY');

    if (!apiKey) {
      console.warn('[codex-review] OPENAI_API_KEY not set — Codex Review skipped');
      return {
        output: {
          review: '## Codex Review\n\n**Decision:** APPROVED\n\n**Summary:** Codex Review skipped — OPENAI_API_KEY not set.\n\n### Issues\n\nNo issues found.\n\n### Notes\n- Set OPENAI_API_KEY to enable GPT-4o cross-model review.',
          decision: 'APPROVED',
          skipped: true,
          reason: 'OPENAI_API_KEY not set',
          originalTaskId,
        },
        tokensUsed: 0,
      };
    }

    const prompt = `Review the following agent output for the task described.

Original task: ${originalDesc}

Output to review:
---
${originalOutput}
---

Apply your code and quality review checklist. Produce the structured review.`;

    const result = await callGpt(prompt, apiKey);

    const approved = result.text.includes('**Decision:** APPROVED') ||
                     result.text.includes('Decision: APPROVED');

    return {
      output: {
        review: result.text,
        decision: approved ? 'APPROVED' : 'NEEDS_REVISION',
        originalTaskId,
        skipped: false,
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
