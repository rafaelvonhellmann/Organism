import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

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
    const rawArtifacts = (input?.artifacts as string) ?? '';
    // Cap artifacts to prevent giant payloads
    const artifacts = rawArtifacts.slice(0, 5000);

    // For HIGH-lane review tasks, scope to security-relevant context only
    const isReviewTask = (input?.reviewType as string) === 'high-lane-pipeline';
    let contextBlock = '';
    if (isReviewTask) {
      // Only pass the output being reviewed + security-relevant fields
      const output = ((input?.output as string) ?? '').slice(0, 4000);
      const desc = (input?.originalDescription as string) ?? task.description;
      contextBlock = `Output under review:\n---\n${output}\n---\n\nOriginal task: ${desc.slice(0, 300)}`;
    } else {
      contextBlock = artifacts || '(No artifacts provided — produce a security framework and checklist based on the task description)';
    }

    const prompt = `Conduct a security audit.

Task: ${task.description.slice(0, 500)}

Scope: ${scope}

Artifacts / context provided:
---
${contextBlock}
---

Apply OWASP Top 10 (2021) and Australian Privacy Act obligations. Produce the full security audit report.`;

    const result = await callModelUltra(prompt, 'sonnet', SYSTEM);

    return {
      output: { report: result.text },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
