import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import { createTask } from '../../packages/core/src/task-queue.js';

const SYSTEM = `You are a security auditor applying OWASP Top 10 (2021) and Australian Privacy Act 1988 obligations.

You assess authentication flows, API security, data exposure risks, and infrastructure configuration.

Australian context: the Notifiable Data Breaches (NDB) scheme (Part IIIC, Privacy Act 1988) requires breach notification within 30 days. APP 11 mandates reasonable security for personal information. Health and study data held by Synapse qualifies as personal information.

OWASP Top 10 (2021) categories you assess:
- A01 Broken Access Control
- A02 Cryptographic Failures
- A03 Injection
- A04 Insecure Design
- A05 Security Misconfiguration
- A06 Vulnerable and Outdated Components
- A07 Identification and Authentication Failures
- A08 Software and Data Integrity Failures
- A09 Security Logging and Monitoring Failures
- A10 Server-Side Request Forgery (SSRF)

Output format (strictly follow):
## Security Audit Report

**Scope:** [what was audited]

**Overall Risk:** CRITICAL | HIGH | MEDIUM | LOW

**Findings:**

### AUDIT-001
- **OWASP:** [A0X:2021 Category Name]
- **Severity:** CRITICAL | HIGH | MEDIUM | LOW
- **Description:** [what the issue is]
- **Evidence:** [file, endpoint, config, or code snippet where found]
- **Remediation:** [specific actionable steps]
- **Privacy Act implication:** [APP/NDB obligation, or "None"]

[Repeat for each finding]

**Summary:** [total findings by severity — e.g., "2 CRITICAL, 1 HIGH, 3 MEDIUM"]

Rules:
- CRITICAL means exploitable without authentication or causes data breach.
- Evidence must be specific — never say "might be vulnerable" without citing the location.
- Every CRITICAL or HIGH finding must include a remediation deadline recommendation.
- Be terse. No preamble.`;

export default class SecurityAuditAgent extends BaseAgent {
  constructor() {
    super({
      name: 'security-audit',
      model: 'sonnet',
      capability: {
        id: 'security.audit',
        owner: 'security-audit',
        collaborators: ['legal'],
        reviewerLane: 'HIGH',
        description: 'OWASP Top 10 assessment with Australian Privacy Act NDB scheme obligations',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const scope = (input?.scope as string) ?? 'full application';
    const artifacts = (input?.artifacts as string) ?? '';

    const prompt = `Conduct a security audit.

Task: ${task.description}

Scope: ${scope}

Artifacts / context provided:
---
${artifacts || '(No artifacts provided — produce a security framework and checklist based on the task description)'}
---

Apply OWASP Top 10 (2021) and Australian Privacy Act obligations. Produce the full security audit report.`;

    const result = await callModelUltra(prompt, 'sonnet', SYSTEM);

    createTask({
      agent: 'quality-agent',
      lane: 'LOW',
      description: `Quality review: "${task.description.slice(0, 80)}"`,
      input: {
        originalTaskId: task.id,
        originalDescription: task.description,
        output: result.text,
      },
      parentTaskId: task.id,
      projectId: task.projectId,
    });

    return {
      output: { report: result.text, qualityReviewQueued: true },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
