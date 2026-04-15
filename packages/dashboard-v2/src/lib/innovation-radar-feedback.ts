export type InnovationRadarFeedbackCode =
  | 'APPROVED'
  | 'REJECTED_IRRELEVANT'
  | 'REJECTED_NOT_NOVEL'
  | 'REJECTED_WEAK_EVIDENCE'
  | 'REJECTED_TOO_COSTLY'
  | 'REJECTED_NOT_NOW';

export interface InnovationRadarFeedbackRow {
  opportunityTitle: string | null;
  feedbackCode: InnovationRadarFeedbackCode;
  notes: string | null;
  trigger: string | null;
}

export interface InnovationRadarReviewOption {
  code: Exclude<InnovationRadarFeedbackCode, 'APPROVED'>;
  label: string;
  hint: string;
}

export const INNOVATION_RADAR_REVIEW_OPTIONS: InnovationRadarReviewOption[] = [
  {
    code: 'REJECTED_IRRELEVANT',
    label: 'Irrelevant',
    hint: 'Does not map to a real project need',
  },
  {
    code: 'REJECTED_NOT_NOVEL',
    label: 'Not novel',
    hint: 'Already known or already on the roadmap',
  },
  {
    code: 'REJECTED_WEAK_EVIDENCE',
    label: 'Weak evidence',
    hint: 'Needs stronger primary sources or proof',
  },
  {
    code: 'REJECTED_TOO_COSTLY',
    label: 'Too costly',
    hint: 'Potentially valid, but too heavy for the expected upside',
  },
  {
    code: 'REJECTED_NOT_NOW',
    label: 'Not now',
    hint: 'Worth revisiting only after a trigger changes',
  },
];

const STRUCTURED_REASON_PREFIX = '[RADAR_FEEDBACK=';

interface ParsedStructuredReason {
  code: InnovationRadarFeedbackCode;
  note: string | null;
}

export function composeInnovationRadarReason(
  code: Exclude<InnovationRadarFeedbackCode, 'APPROVED'>,
  note?: string,
): string {
  const trimmed = note?.trim();
  return `${STRUCTURED_REASON_PREFIX}${code}]${trimmed ? ` ${trimmed}` : ''}`;
}

function parseStructuredReason(reason?: string | null): ParsedStructuredReason | null {
  if (!reason) return null;
  const match = reason.match(/^\[RADAR_FEEDBACK=(APPROVED|REJECTED_IRRELEVANT|REJECTED_NOT_NOVEL|REJECTED_WEAK_EVIDENCE|REJECTED_TOO_COSTLY|REJECTED_NOT_NOW)\]\s*(.*)$/);
  if (!match) return null;
  return {
    code: match[1] as InnovationRadarFeedbackCode,
    note: match[2]?.trim() ? match[2].trim() : null,
  };
}

function extractRadarText(output: unknown): string {
  if (!output) return '';

  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      if (typeof parsed.text === 'string') return parsed.text;
      if (typeof parsed.analysis === 'string') return parsed.analysis;
      return output;
    } catch {
      return output;
    }
  }

  if (typeof output === 'object' && output !== null) {
    const parsed = output as Record<string, unknown>;
    if (typeof parsed.text === 'string') return parsed.text;
    if (typeof parsed.analysis === 'string') return parsed.analysis;
    return JSON.stringify(parsed);
  }

  return String(output);
}

function extractOpportunityTitles(output: unknown): string[] {
  const text = extractRadarText(output);
  const matches = [...text.matchAll(/^### Opportunity \d+:\s+(.+)$/gm)];
  return matches
    .map((match) => match[1]?.trim())
    .filter((title): title is string => Boolean(title && title.length > 0));
}

function inferFeedbackCode(
  decision: 'approved' | 'changes_requested' | 'rejected' | 'dismissed',
  reason?: string | null,
): InnovationRadarFeedbackCode {
  if (decision === 'approved') return 'APPROVED';
  const structured = parseStructuredReason(reason);
  if (structured) return structured.code;

  const note = (reason ?? '').toLowerCase();

  if (/(not now|later|defer|deferred|premature|timing|wait|after |until |once )/.test(note)) {
    return 'REJECTED_NOT_NOW';
  }
  if (/(evidence|source|proof|citation|substantiat|primary source|weak support|hand-?wavy)/.test(note)) {
    return 'REJECTED_WEAK_EVIDENCE';
  }
  if (/(novel|not new|already know|already knew|obvious|already planned|already on the roadmap|already doing)/.test(note)) {
    return 'REJECTED_NOT_NOVEL';
  }
  if (/(too costly|too expensive|too much work|too much effort|high effort|too complex|complexity|scope|heavy lift)/.test(note)) {
    return 'REJECTED_TOO_COSTLY';
  }
  return 'REJECTED_IRRELEVANT';
}

function inferTrigger(code: InnovationRadarFeedbackCode, reason?: string | null): string | null {
  if (code !== 'REJECTED_NOT_NOW') return null;
  const structured = parseStructuredReason(reason);
  const trimmed = structured?.note ?? reason?.trim();
  if (!trimmed) return null;
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

export function buildInnovationRadarFeedbackRows(params: {
  decision: 'approved' | 'changes_requested' | 'rejected' | 'dismissed';
  reason?: string | null;
  output: unknown;
}): InnovationRadarFeedbackRow[] {
  const feedbackCode = inferFeedbackCode(params.decision, params.reason);
  const titles = extractOpportunityTitles(params.output);
  const trigger = inferTrigger(feedbackCode, params.reason);
  const structured = parseStructuredReason(params.reason);
  const notes = structured?.note ?? (params.reason?.trim() ? params.reason.trim() : null);

  if (titles.length === 0) {
    return [{
      opportunityTitle: null,
      feedbackCode,
      notes,
      trigger,
    }];
  }

  return titles.map((title) => ({
    opportunityTitle: title,
    feedbackCode,
    notes,
    trigger,
  }));
}
