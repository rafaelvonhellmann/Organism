# Organism Legal Review Playbook

This playbook adapts the document-aware workflow pattern from Microsoft Word Legal Agent to Organism's Australian-law review lane. Reference sources: Microsoft Tech Community, "Word: Legal Agent in Frontier" (2026-04-30), and Microsoft Support, "Get started with the Legal Agent (Frontier)." It is not a source of legal advice. It is an agent-facing checklist for producing auditable legal findings, source citations, and deterministic edit proposals that Rafael can accept, dismiss, or escalate to a qualified solicitor.

## Workflow Contract

1. Review against topics, not vibes.
2. Cite the source language or file path for every finding.
3. Tie each finding to a playbook rule and applicable law.
4. Propose edits as structured redline operations, not freeform rewrites.
5. Keep prior review history intact. Do not overwrite negotiation or audit context.
6. Rafael must approve all legal edits before they ship.
7. Mark solicitor-required items explicitly when professional judgement is needed.

## Topic Statuses

Use these statuses for every relevant topic:

| Status | Meaning | Required response |
| --- | --- | --- |
| GRAY | Not relevant to the reviewed material | Explain why it is not relevant in one sentence |
| GREEN | Complies with the playbook rule | Cite the source language that supports compliance |
| LIGHT_RED | Existing language needs a targeted edit | Propose `replace_clause` or `add_comment` |
| DARK_RED | A whole clause, disclaimer, policy section, or approval step is missing or must be removed | Propose `add_clause`, `remove_clause`, or `escalate` |

## Redline Operation Schema

Legal Agent outputs should include a fenced JSON object with a `redlineProposals` array. Each entry must follow this shape:

```json
{
  "redlineProposals": [
    {
      "operation": "replace_clause | add_clause | remove_clause | add_comment | no_change | escalate",
      "target": "stable section name, file path, clause heading, or document anchor",
      "sourceCitation": "quoted source snippet, file path, line number, or task evidence key",
      "playbookTopic": "topic id from this playbook",
      "applicableLaw": "specific act / principle / section where possible",
      "risk": "LOW | MEDIUM | HIGH | CRITICAL",
      "reason": "why the operation is needed",
      "replacement": "proposed clause text, or null when not applicable",
      "comment": "optional reviewer-facing comment",
      "approvalRequired": "rafael | solicitor | none"
    }
  ]
}
```

Use `no_change` only when the topic is GREEN and the source citation is strong. Use `escalate` when a qualified Australian solicitor must decide the issue.

## Core Topics

### LEG-PRIVACY-APP

Rule: Products collecting personal information must explain collection, use, disclosure, retention, access, correction, and security in a way aligned to the Privacy Act 1988 (Cth) and the Australian Privacy Principles.

Check:
- APP 1: open and transparent management of personal information.
- APP 3: collection is reasonably necessary and clearly described.
- APP 6: use and disclosure stay within stated purposes.
- APP 11: reasonable security and retention/destruction controls.
- APP 12 and APP 13: access and correction rights.
- NDB scheme: serious eligible data breach assessment and notification process.

Redline triggers:
- DARK_RED if there is no privacy policy or no sensitive-information section where health/study-performance data is collected.
- LIGHT_RED if the policy exists but omits AI processing, third-party processors, retention, access/correction, or breach handling.

### LEG-HEALTH-EDUCATION

Rule: Synapse-style medical exam preparation must be framed as education, not clinical advice, diagnosis, treatment, or professional medical supervision.

Check:
- AHPRA advertising/professional-boundary concerns.
- TGA SaMD risk if the product appears to provide clinical decision support rather than education.
- Disclaimers for AI-generated grading, VIVA role-play, feedback, and benchmark answers.

Redline triggers:
- DARK_RED if the product claims clinical reliability or medical decision support.
- LIGHT_RED if education disclaimers are present but not displayed near AI grading or VIVA feedback.

### LEG-COPYRIGHT-COLLEGE

Rule: Do not publish or monetize copied exam wording, college-owned question text, or copyrighted source material unless there is permission, a defensible exception, or sufficiently original rewriting.

Check:
- Copyright Act 1968 (Cth), including fair dealing limits.
- Distinguish uncopyrightable topics from protected expression.
- Verify any existing copyright audit before adding duplicate findings.
- Require originality review for generated/enriched questions.

Redline triggers:
- DARK_RED for verbatim recalled exam questions, exam-code/year references tied to copied wording, or missing copyright disclaimer when exam content is present.
- LIGHT_RED for weak attribution/originality review controls.

### LEG-CONSUMER-SUBSCRIPTIONS

Rule: Paid plans, subscriptions, refunds, cancellation, and feature availability must avoid misleading or deceptive conduct and align with Australian Consumer Law obligations.

Check:
- ACL s18 misleading/deceptive conduct.
- ACL s29 false or misleading representations.
- Consumer guarantees and refund/cancellation clarity.
- Claims about completeness, pass likelihood, accuracy, or AI reliability.

Redline triggers:
- DARK_RED if billing exists without terms, cancellation, refund, and consumer guarantee language.
- LIGHT_RED if marketing claims overstate coverage, accuracy, or outcomes.

### LEG-MARKETING-SPAM

Rule: Commercial electronic messages need consent, sender identification, and functional unsubscribe.

Check:
- Spam Act 2003 (Cth).
- Outreach lists, campaign copy, onboarding email flows, and community messages.

Redline triggers:
- DARK_RED if campaign sending is planned without consent/unsubscribe mechanics.
- LIGHT_RED if consent source or unsubscribe language is unclear.

### LEG-AI-OUTPUTS-IP

Rule: AI-generated outputs need clear ownership, reuse, and limitation language, especially for generated study content, research outputs, or partner-facing artifacts.

Check:
- IP ownership terms.
- Third-party model/provider terms.
- User-submitted content rights.
- Restrictions on relying on generated outputs as professional advice.

Redline triggers:
- DARK_RED if user/AI output ownership is not addressed in terms for a monetized product.
- LIGHT_RED if permitted reuse is unclear.

### LEG-DONATION-RESEARCH

Rule: Tokens for Good-style donor and research workflows must distinguish public research claims from restricted/PII/PHI material and avoid overstating research impact.

Check:
- Donor email and contribution history as personal information.
- Sensitivity classification and PHI blocking.
- Data sovereignty and processor disclosure.
- Evidence/citation chain for impact claims.
- Partner review before public claims.

Redline triggers:
- DARK_RED if donor PII or PHI can flow into public artifacts.
- LIGHT_RED if research-impact claims lack citations or partner approval.

## Output Template

Every Legal Agent response must include:

1. `## Jurisdiction`
2. `## Playbook Review Summary`
3. `## Findings and Citations`
4. `## Structured Redline Proposals`
5. `## Risk Rating`
6. `## Applicable Law`
7. `## Required Actions`
8. `## Disclaimer`
9. `## Next Review`

Findings must be specific. If no source citation is available, mark the finding `REQUIRES REVIEW` instead of asserting a violation.
