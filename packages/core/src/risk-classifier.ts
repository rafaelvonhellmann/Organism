import { RiskClassification, RiskLane } from '../../shared/src/types.js';
import { callModel } from '../../../agents/_base/mcp-client.js';

// Smell-test: zero cost regex pre-filter.
//
// HIGH = actions that are hard to reverse, cost money, or affect real users:
//   - Deployment to production
//   - Sending emails/notifications to users
//   - Spending money (API credits, purchases, billing changes)
//   - Changing product quality (enrichment, medical content, grading)
//   - Database schema changes, data deletion
//   - Auth/permission CHANGES (not reviews/audits)
//
// Reviews, audits, analysis, and strategy docs are NOT high-risk — they
// produce documents, not side effects. Those go through MEDIUM (Codex review).

// HIGH: actions with irreversible side effects
const HIGH_RISK_ACTION_PATTERNS = [
  /\b(deploy|push to prod|release|ship)\b/i,
  /\b(send|email|notify|notification)\b.*\b(user|customer|patient)/i,
  /\b(payment|billing|invoice|charge|purchase|spend|buy)\b/i,
  /\b(delete|drop|truncate|remove all|destroy)\b/i,
  /\b(migrate|migration|schema change|alter table)\b/i,
  /\b(change|modify|update|fix)\b.*\b(auth|password|permission|rls|row.level)/i,
  /\b(enrich|grade|score)\b.*\b(content|medical|mcq|saq|viva|lo)\b/i,
  /\b(prod|production)\b.*\b(push|deploy|update|change)\b/i,
];

// Signals that downgrade to MEDIUM even if keywords match — read-only analysis
const ANALYSIS_DAMPENERS = [
  /\b(review|audit|analyse|analyze|assess|evaluate|inspect|check|verify)\b/i,
  /\b(strategy|plan|proposal|recommendation|report|analysis|findings)\b/i,
  /\b(shadow|shaping|research|investigate|explore|compare)\b/i,
];

function smellTest(description: string, loc?: number): RiskLane | null {
  const lower = description.toLowerCase();

  // Check if this looks like analysis/review (read-only, no side effects)
  const isAnalysis = ANALYSIS_DAMPENERS.some(p => p.test(description));

  // Only flag HIGH if it matches an action pattern AND isn't just analysis
  for (const pattern of HIGH_RISK_ACTION_PATTERNS) {
    if (pattern.test(description) && !isAnalysis) return 'HIGH';
  }

  // Large LOC changes are MEDIUM, not auto-HIGH (Codex will review)
  if (loc && loc > 500) return 'MEDIUM';

  return null; // Needs classifier
}

const RISK_CLASSIFIER_PROMPT = `Classify the following task as LOW, MEDIUM, or HIGH risk.

Risk definitions:
- LOW: Internal analysis, strategy docs, research, competitive intel, financial ANALYSIS (reading not spending), documentation, planning
- MEDIUM: Code changes, architecture reviews, security audits (read-only), marketing content, customer-facing copy, refactors, API design
- HIGH: Production deployment, sending emails/notifications to users, spending money (API credits, purchases), changing product quality (enrichment, grading, medical content), database migrations/data deletion, auth/permission CHANGES (not reviews)

Key distinction: REVIEWS and AUDITS are MEDIUM (they produce documents). CHANGES and ACTIONS are HIGH (they have side effects). A "security audit" is MEDIUM; "fix auth vulnerability" is HIGH.

Task: {{TASK}}

Respond with ONLY a JSON object, no other text:
{"lane":"LOW","reason":"one sentence","factors":["factor1"]}`;

// Real Haiku classifier — ~$0.001 per call.
async function classifyWithHaiku(description: string): Promise<RiskClassification> {
  try {
    const result = await callModel(
      RISK_CLASSIFIER_PROMPT.replace('{{TASK}}', description),
      'haiku'
    );
    // Extract JSON from response (Haiku sometimes adds surrounding text)
    const jsonMatch = result.text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { lane?: string; reason?: string; factors?: string[] };
      const lane = (['LOW', 'MEDIUM', 'HIGH'].includes(parsed.lane ?? ''))
        ? parsed.lane as RiskLane
        : 'MEDIUM';
      return {
        lane,
        reason: parsed.reason ?? 'Classified by Haiku',
        factors: parsed.factors ?? [],
        method: 'classifier',
      };
    }
  } catch {
    // Fall through to heuristic if API is unavailable (no key, network error, etc.)
  }

  // Heuristic fallback — used when the classifier call fails or no backend is available
  const lower = description.toLowerCase();
  const highSignals = ['deploy', 'send email', 'notify user', 'delete', 'drop table', 'migration', 'spend', 'purchase', 'enrich'];
  const mediumSignals = ['code', 'feature', 'marketing', 'campaign', 'copy', 'design', 'api', 'integration', 'refactor', 'review', 'audit', 'security'];
  const isAnalysis = /\b(review|audit|analy|assess|research|strategy|plan|report)\b/i.test(description);
  const isHigh = !isAnalysis && highSignals.some((s) => lower.includes(s));
  const isMedium = mediumSignals.some((s) => lower.includes(s));
  return {
    lane: isHigh ? 'HIGH' : isMedium ? 'MEDIUM' : 'LOW',
    reason: isHigh ? 'Task involves irreversible action (heuristic)' : isMedium ? 'Task involves code or customer-facing content (heuristic)' : 'Routine internal task (heuristic)',
    factors: ['API unavailable — fell back to heuristic'],
    method: 'classifier',
  };
}

export async function classifyRisk(
  description: string,
  options: { loc?: number } = {}
): Promise<RiskClassification> {
  // Step 1: Free smell-test
  const smellResult = smellTest(description, options.loc);
  if (smellResult === 'HIGH') {
    return {
      lane: 'HIGH',
      reason: 'Matched high-risk keyword or pattern',
      factors: [],
      method: 'smell-test',
    };
  }

  // Step 2: Haiku classifier (~$0.001)
  return classifyWithHaiku(description);
}
