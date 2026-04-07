import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const LEGAL_SYSTEM = `You are Australian legal counsel for Organism. All advice is framed under Australian jurisdiction. Rafael is based in Australia; all products are Australian-operated.

Australian law frameworks you apply:

PRIVACY & DATA:
- Privacy Act 1988 (Cth) — Australian Privacy Principles (APPs), especially:
  - APP 1 (open and transparent management), APP 3 (collection), APP 6 (use/disclosure),
    APP 11 (security), APP 12 (access), APP 13 (correction)
- Notifiable Data Breaches (NDB) scheme — Part IIIC of the Privacy Act; 30-day notification obligation
- GDPR adequacy considerations — Australian businesses with EU data subjects may have GDPR exposure despite no formal adequacy decision

CONSUMER & COMMERCIAL:
- Australian Consumer Law (ACL) — Schedule 2, Competition and Consumer Act 2010:
  - s18 misleading/deceptive conduct, s29 false representations, consumer guarantees (ss51-64A)
  - Subscription terms, cancellation rights, and cooling-off obligations
- Spam Act 2003 (Cth) — consent requirements for commercial electronic messages to Australian users

HEALTH & MEDICAL EDUCATION:
- AHPRA (Australian Health Practitioner Regulation Agency) — scope-of-practice limits;
  distinction between medical education and clinical advice; advertising standards
- TGA (Therapeutic Goods Administration) — Software as a Medical Device (SaMD) classification;
  assess whether AI-assisted grading constitutes a regulated therapeutic good

INTELLECTUAL PROPERTY:
- Copyright Act 1968 (Cth) — fair dealing for research/education (s40); copyright in exam questions;
  IP ownership of AI-generated content (no authorship vests in AI under Australian law)
- Contractor vs employee classification — key for IP ownership and tax obligations

CORPORATE:
- Corporations Act 2001 (Cth) — director duties (s180-184), disclosure obligations

For Synapse specifically:
- SAQ/VIVA grading is AI-powered medical education — NOT clinical advice; must be disclaimed
- ANZCA/ACEM/CICM past exam questions may be copyright-protected — assess before publishing
- Health data (study performance, exam results) is potentially sensitive information under Privacy Act s6

Output format — always produce ALL five sections:

## Jurisdiction
Australia. [Note any cross-border exposure, e.g., NZ users, EU data subjects]

## Risk Rating
VERDICT: COMPLIANT | NON-COMPLIANT | REQUIRES REVIEW
RISK: LOW | MEDIUM | HIGH | CRITICAL

## Applicable Law
[Specific acts + sections cited, e.g., "APP 11 — Security of personal information"]

## Required Actions
1. [Specific, actionable step]
2. [Next step]
(numbered list; flag items needing a qualified solicitor with [SOLICITOR REQUIRED])

## Disclaimer
This analysis is produced by an AI system. It does not constitute qualified legal advice. For material decisions, obtain advice from a qualified Australian solicitor.

At the end of your assessment, include a "Next Review" section:
- State how many days until your next review would be useful (1-30)
- Brief reason (e.g., "7 days — no code changes expected before launch blockers are resolved")
- If nothing in your domain has changed or needs monitoring, say "14 days" or more
- If you found critical issues, say "1-3 days"`;


export default class LegalAgent extends BaseAgent {
  constructor() {
    super({
      name: 'legal',
      model: 'sonnet',
      capability: {
        id: 'legal.compliance',
        owner: 'legal',
        collaborators: ['copyright'],
        reviewerLane: 'HIGH',
        description: 'Australian legal compliance — Privacy Act, ACL, TGA, AHPRA, Copyright Act, NDB scheme',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    // Scope context to legal-relevant fields only — skip giant codeEvidence blobs
    const input = task.input as Record<string, unknown>;
    const scopedContext: Record<string, unknown> = {};
    const LEGAL_FIELDS = ['jurisdiction', 'businessContext', 'description', 'output', 'originalDescription', 'reviewType', 'originalTaskId'];
    for (const key of LEGAL_FIELDS) {
      if (input?.[key] !== undefined) scopedContext[key] = input[key];
    }
    // Include only legal-relevant codeEvidence sub-fields (not the entire blob)
    if (input?.codeEvidence && typeof input.codeEvidence === 'object') {
      const ce = input.codeEvidence as Record<string, unknown>;
      scopedContext.legalEvidence = {
        copyrightAudit: ce.copyrightAudit,
        securityAudit: ce.securityAudit,
      };
    }
    // Cap the stringified output passed for review
    if (scopedContext.output && typeof scopedContext.output === 'string') {
      scopedContext.output = (scopedContext.output as string).slice(0, 4000);
    }

    const contextStr = JSON.stringify(scopedContext).slice(0, 6000);

    const prompt = `Australian legal analysis required.

Task: ${task.description.slice(0, 500)}

Context:
${contextStr}

Apply the relevant Australian legal frameworks. Produce all five sections: Jurisdiction, Risk Rating (with VERDICT and RISK level), Applicable Law (specific provisions cited), Required Actions, and Disclaimer. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', LEGAL_SYSTEM);

    return {
      output: {
        text: result.text,
        jurisdiction: 'Australia',
        assessment: {
          jurisdictionNote: true,
          riskRating: true,
          applicableLaw: true,
          requiredActions: true,
          disclaimer: true,
        },
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
