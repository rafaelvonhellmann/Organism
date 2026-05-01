import * as fs from 'fs';
import * as path from 'path';
import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';

const LEGAL_PLAYBOOK_PATH = 'knowledge/legal/playbooks/organism-legal-review-playbook.md';
const LEGAL_PLAYBOOK_ABS_PATH = path.resolve(process.cwd(), LEGAL_PLAYBOOK_PATH);

interface RedlineProposal {
  operation: 'replace_clause' | 'add_clause' | 'remove_clause' | 'add_comment' | 'no_change' | 'escalate';
  target: string;
  sourceCitation: string;
  playbookTopic: string;
  applicableLaw: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reason: string;
  replacement: string | null;
  comment: string;
  approvalRequired: 'rafael' | 'solicitor' | 'none';
}

const LEGAL_SYSTEM = `You are Australian legal counsel for Organism. All advice is framed under Australian jurisdiction. Rafael is based in Australia; all products are Australian-operated.

You work like a playbook-driven legal review agent:
- Review against explicit playbook topics, not generic legal vibes.
- Every finding must include a source citation from task evidence, reviewed text, file path, selected clause, or supplied context.
- If you cannot cite the source language, mark the item REQUIRES REVIEW instead of asserting a violation.
- Propose legal edits as deterministic redline operations. Do not pretend edits have been applied.
- Rafael must approve or dismiss every proposed edit. Mark solicitor-required judgement explicitly.
- Keep Paperclip as the only orchestrator; do not create tasks or call other agents.

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

Output format — always produce ALL nine sections:

## Jurisdiction
Australia. [Note any cross-border exposure, e.g., NZ users, EU data subjects]

## Playbook Review Summary
Table with columns: Topic, Status (GRAY | GREEN | LIGHT_RED | DARK_RED), Verdict, Source Citation, Approval Required.

## Findings and Citations
For each issue or compliance point:
- Playbook topic
- Status
- Source citation
- Applicable law
- Risk
- Analysis
- Suggested redline operation id, or "none"

## Structured Redline Proposals
Return a fenced JSON object with a redlineProposals array. Each proposal must include:
- operation: replace_clause | add_clause | remove_clause | add_comment | no_change | escalate
- target: stable section name, file path, clause heading, or document anchor
- sourceCitation
- playbookTopic
- applicableLaw
- risk: LOW | MEDIUM | HIGH | CRITICAL
- reason
- replacement: proposed clause text or null
- comment
- approvalRequired: rafael | solicitor | none

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

function loadLegalPlaybook(): string {
  try {
    return fs.readFileSync(LEGAL_PLAYBOOK_ABS_PATH, 'utf8').slice(0, 12000);
  } catch {
    return '';
  }
}

function truncateLegalValue(value: unknown, maxChars: number): unknown {
  if (typeof value === 'string') {
    return value.length > maxChars ? `${value.slice(0, maxChars)}...[truncated]` : value;
  }
  if (value && typeof value === 'object') {
    const serialized = JSON.stringify(value);
    return serialized.length > maxChars ? `${serialized.slice(0, maxChars)}...[truncated]` : value;
  }
  return value;
}

function isRedlineProposal(value: unknown): value is RedlineProposal {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.operation === 'string'
    && ['replace_clause', 'add_clause', 'remove_clause', 'add_comment', 'no_change', 'escalate'].includes(obj.operation)
    && typeof obj.target === 'string'
    && typeof obj.sourceCitation === 'string'
    && typeof obj.playbookTopic === 'string'
    && typeof obj.applicableLaw === 'string'
    && typeof obj.risk === 'string'
    && ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(obj.risk)
    && typeof obj.reason === 'string'
    && (typeof obj.replacement === 'string' || obj.replacement === null)
    && typeof obj.comment === 'string'
    && typeof obj.approvalRequired === 'string'
    && ['rafael', 'solicitor', 'none'].includes(obj.approvalRequired);
}

function extractRedlineProposals(text: string): RedlineProposal[] {
  const jsonBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const candidates = jsonBlocks.length > 0 ? jsonBlocks : [text];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const proposals = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>).redlineProposals
          : null;

      if (Array.isArray(proposals)) {
        return proposals.filter(isRedlineProposal);
      }
    } catch {
      // Continue looking for another JSON block.
    }
  }

  return [];
}

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
        knowledgeSources: [LEGAL_PLAYBOOK_PATH],
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    // Scope context to legal-relevant fields only — skip giant codeEvidence blobs
    const input = task.input as Record<string, unknown>;
    const scopedContext: Record<string, unknown> = {};
    const LEGAL_FIELDS = [
      'jurisdiction',
      'businessContext',
      'description',
      'output',
      'originalDescription',
      'reviewType',
      'originalTaskId',
      'selectedText',
      'sourceDocument',
      'sourceCitation',
      'documentText',
      'clauses',
      'contractText',
      'termsText',
      'privacyPolicy',
      'marketingCopy',
      'legalPlaybook',
    ];
    for (const key of LEGAL_FIELDS) {
      if (input?.[key] !== undefined) scopedContext[key] = truncateLegalValue(input[key], 5000);
    }
    // Include only legal-relevant codeEvidence sub-fields (not the entire blob)
    if (input?.codeEvidence && typeof input.codeEvidence === 'object') {
      const ce = input.codeEvidence as Record<string, unknown>;
      scopedContext.legalEvidence = {
        copyrightAudit: ce.copyrightAudit,
        securityAudit: ce.securityAudit,
      };
    }
    if (input?.knowledgeSources && typeof input.knowledgeSources === 'object') {
      const sources = input.knowledgeSources as Record<string, unknown>;
      const additionalSources = Object.fromEntries(
        Object.entries(sources).filter(([sourcePath]) => sourcePath !== LEGAL_PLAYBOOK_PATH),
      );
      if (Object.keys(additionalSources).length > 0) {
        scopedContext.additionalKnowledgeSources = truncateLegalValue(additionalSources, 4000);
      }
    }
    // Cap the stringified output passed for review
    if (scopedContext.output && typeof scopedContext.output === 'string') {
      scopedContext.output = (scopedContext.output as string).slice(0, 4000);
    }

    const playbook = loadLegalPlaybook();
    const contextStr = JSON.stringify(scopedContext).slice(0, 9000);

    const prompt = `Australian playbook-driven legal analysis required.

Task: ${task.description.slice(0, 500)}

Organism legal review playbook:
---
${playbook}
---

Context:
${contextStr}

Apply the relevant Australian legal frameworks and the playbook topics.

Produce all nine sections: Jurisdiction, Playbook Review Summary, Findings and Citations, Structured Redline Proposals, Risk Rating, Applicable Law, Required Actions, Disclaimer, and Next Review.

Do not claim a redline has been applied. Propose deterministic edit operations for Rafael's approval. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', LEGAL_SYSTEM);
    const redlineProposals = extractRedlineProposals(result.text);

    return {
      output: {
        text: result.text,
        jurisdiction: 'Australia',
        playbookDriven: true,
        playbookPath: LEGAL_PLAYBOOK_PATH,
        redlineProposals,
        approvalFlow: ['accept', 'dismiss', 'accept_with_comment'],
        assessment: {
          jurisdictionNote: true,
          playbookReviewSummary: true,
          findingsAndCitations: true,
          structuredRedlineProposals: true,
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
