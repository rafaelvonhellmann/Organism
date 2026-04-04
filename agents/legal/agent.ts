import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import { createTask } from '../../packages/core/src/task-queue.js';

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
This analysis is produced by an AI system. It does not constitute qualified legal advice. For material decisions, obtain advice from a qualified Australian solicitor.`;

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
    const prompt = `Australian legal analysis required.

Task: ${task.description}

Context:
${JSON.stringify(task.input, null, 2)}

Apply the relevant Australian legal frameworks. Produce all five sections: Jurisdiction, Risk Rating (with VERDICT and RISK level), Applicable Law (specific provisions cited), Required Actions, and Disclaimer. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', LEGAL_SYSTEM);

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
      output: {
        text: result.text,
        qualityReviewQueued: true,
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
