import { RiskClassification, RiskLane } from '../../shared/src/types.js';
import { callModel } from '../../../agents/_base/mcp-client.js';

// Smell-test: zero cost regex pre-filter that catches ~70% of HIGH-risk tasks
// before spending a Haiku token.
const HIGH_RISK_KEYWORDS = [
  'deploy', 'push to prod', 'release', 'ship',
  'payment', 'pricing', 'billing', 'invoice', 'charge',
  'auth', 'password', 'token', 'session', 'oauth',
  'delete', 'drop', 'truncate', 'remove all',
  'legal', 'compliance', 'gdpr', 'copyright',
  'security', 'vulnerability', 'cve', 'exploit',
  'admin', 'root access', 'sudo',
];

const HIGH_RISK_PATTERNS = [
  /\[URGENT\]/i,
  /\b(prod|production)\b/i,
  /\bauth(entication|orization)?\b/i,
  /\bpayment(s)?\b/i,
  /\bapi\/admin\b/i,
];

function smellTest(description: string, loc?: number): RiskLane | null {
  const lower = description.toLowerCase();

  if (loc && loc > 500) return 'HIGH';

  for (const keyword of HIGH_RISK_KEYWORDS) {
    if (lower.includes(keyword)) return 'HIGH';
  }

  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(description)) return 'HIGH';
  }

  return null; // Needs classifier
}

const RISK_CLASSIFIER_PROMPT = `Classify the following task as LOW, MEDIUM, or HIGH risk.

Risk definitions:
- LOW: Routine internal tasks — planning, documentation, analysis, content for internal use, mission/OKR statements
- MEDIUM: Code changes, customer-facing content, integrations, marketing campaigns, API design
- HIGH: Production deployments, authentication/security, payment/billing, data deletion, legal/compliance, medical content grading

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

  // Heuristic fallback — used when ANTHROPIC_API_KEY is not set
  const lower = description.toLowerCase();
  const mediumSignals = ['code', 'feature', 'marketing', 'campaign', 'copy', 'content', 'design', 'api', 'integration', 'refactor'];
  const isMedium = mediumSignals.some((s) => lower.includes(s));
  return {
    lane: isMedium ? 'MEDIUM' : 'LOW',
    reason: isMedium ? 'Task involves code or customer-facing content (heuristic)' : 'Routine internal task (heuristic)',
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
