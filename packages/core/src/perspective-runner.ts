import { callModelUltra } from '../../../agents/_base/mcp-client.js';
import { selectPerspectives, recordPerspectiveInvocation } from './perspectives.js';
import { assertBudget, recordSpend, estimateCost } from './budget.js';
import { writeAudit } from './audit.js';
import { createTask, completeTask } from './task-queue.js';
import { Perspective, PerspectiveResult, PerspectiveReviewResult } from '../../shared/src/types.js';

/**
 * Detect uncertainty markers in perspective output.
 * Returns extracted questions if the perspective is unsure about something.
 */
function detectUncertainty(text: string): string[] {
  const questions: string[] = [];
  const lines = text.split('\n');

  // Look for explicit uncertainty patterns
  const uncertaintyPatterns = [
    /\bI need to know\b/i,
    /\bI would need\b/i,
    /\bthis depends on\b/i,
    /\bwithout knowing\b/i,
    /\bcannot determine without\b/i,
    /\bunclear whether\b/i,
    /\bI'm not sure if\b/i,
    /\bI don't have enough context\b/i,
    /\bassumption:\s/i,
    /\bUNVERIFIED ASSUMPTION\b/i,
    /\bI would ask\b/i,
    /\bkey question:\s/i,
  ];

  for (const line of lines) {
    for (const pattern of uncertaintyPatterns) {
      if (pattern.test(line)) {
        // Extract the sentence containing the uncertainty
        const cleaned = line.replace(/^[\s\-\*#>]+/, '').trim();
        if (cleaned.length > 10 && cleaned.length < 500) {
          questions.push(cleaned);
        }
        break; // one match per line is enough
      }
    }
  }

  return questions;
}

// ── Perspective-specific context filtering ──────────────────────────────────
// Each perspective only receives the context fields relevant to its domain.
// This reduces token usage by ~30-60% per perspective call.

const PERSPECTIVE_CONTEXT_MAP: Record<string, string[]> = {
  'strategy': ['description', 'businessContext', 'founder', 'stack', 'enrichmentPipeline'],
  'technology': ['stack', 'codeEvidence', 'keyFiles', 'database', 'testing'],
  'engineering': ['codeEvidence', 'keyFiles', 'database', 'testing', 'stack'],
  'finance': ['businessContext', 'enrichmentPipeline', 'database'],
  'product': ['description', 'businessContext', 'database', 'keyFiles'],
  'marketing': ['description', 'businessContext', 'founder'],
  'legal': ['jurisdiction', 'copyrightAudit', 'securityAudit', 'businessContext'],
  'security': ['codeEvidence', 'securityAudit', 'rateLimiting', 'middleware'],
  'quality': ['codeEvidence', 'testing', 'database', 'keyFiles'],
  'medical': ['database', 'description', 'enrichmentPipeline'],
  'design': ['description', 'keyFiles', 'stack'],
  'data': ['database', 'businessContext', 'description'],
  'community': ['description', 'businessContext', 'founder'],
  'sales': ['businessContext', 'description'],
  'hr': ['businessContext', 'description'],
};

function filterContextForPerspective(context: Record<string, unknown>, domain: string): Record<string, unknown> {
  // Find the best matching domain key
  const domainLower = domain.toLowerCase();
  let allowedKeys: string[] | undefined;
  for (const [key, keys] of Object.entries(PERSPECTIVE_CONTEXT_MAP)) {
    if (domainLower.includes(key)) {
      allowedKeys = keys;
      break;
    }
  }

  // If no match, pass full context (safe fallback)
  if (!allowedKeys) return context;

  // Filter to only allowed keys, plus always include __research and __distilled
  const filtered: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key in context) filtered[key] = context[key];
  }
  if (context.__research) filtered.__research = context.__research;
  if (context.__distilled) filtered.__distilled = context.__distilled;
  return filtered;
}

interface ReviewOptions {
  projectId: string;
  scope?: string;                // e.g. "full review", "technical only"
  context: Record<string, unknown>;  // project-specific context passed to each perspective
  maxPerspectives?: number;
  parentTaskId?: string;
}

/**
 * Run a perspective review — fires selected perspectives in parallel.
 */
export async function runPerspectiveReview(options: ReviewOptions): Promise<PerspectiveReviewResult> {
  const {
    projectId,
    scope = 'full review',
    context,
    maxPerspectives = 15,
    parentTaskId,
  } = options;

  const startTime = Date.now();

  // Load cached research for this project (if any)
  const { loadAllResearch } = await import('./research.js');
  const cachedResearch = loadAllResearch(projectId);
  if (cachedResearch) {
    context.__research = cachedResearch;
    console.log(`[Perspectives] Loaded cached research for ${projectId}`);
  }

  // Load distilled knowledge for this project (if any)
  const { loadDistilled } = await import('./distillation.js');
  const distilled = loadDistilled(projectId);
  if (distilled) {
    context.__distilled = distilled;
    console.log(`[Perspectives] Loaded distilled knowledge for ${projectId}`);
  }

  // 1. Select relevant perspectives for this project
  const perspectives = selectPerspectives(projectId, scope, maxPerspectives);
  console.log(`\n[Perspectives] Selected ${perspectives.length} for ${projectId} (${scope}):`);
  for (const p of perspectives) {
    console.log(`  - ${p.domain} (${p.id})`);
  }

  // 2. Fire all perspectives in parallel
  console.log(`\n[Perspectives] Executing ${perspectives.length} perspectives in parallel...\n`);

  const promises = perspectives.map(p => executePerspective(p, projectId, scope, context));
  const settled = await Promise.allSettled(promises);

  // 3. Collect results
  const results: PerspectiveResult[] = [];
  let totalCost = 0;

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const perspective = perspectives[i];

    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
      totalCost += outcome.value.costUsd;
      console.log(`  [OK] ${perspective.domain}: $${outcome.value.costUsd.toFixed(4)} (${outcome.value.durationMs}ms)`);
    } else {
      console.error(`  [FAIL] ${perspective.domain}: ${outcome.reason}`);
      writeAudit({
        agent: `perspective:${perspective.id}`,
        taskId: parentTaskId ?? 'review',
        action: 'error',
        payload: { error: String(outcome.reason), perspectiveId: perspective.id },
        outcome: 'failure',
      });
    }
  }

  // 3b. Tag outputs with uncertainty markers
  for (const result of results) {
    const uncertainties = detectUncertainty(result.text);
    if (uncertainties.length > 0) {
      result.text += '\n\n---\n**[UNVERIFIED ASSUMPTIONS detected]**\n' +
        uncertainties.map(q => `- ${q}`).join('\n') +
        '\n\n*Organism flagged these for Rafael\'s review. Run with --ask to pause for clarification.*';
    }
  }

  // 4. Create task records in SQLite for each result (preserves audit trail)
  for (const result of results) {
    const task = createTask({
      agent: `perspective:${result.perspectiveId}`,
      lane: 'LOW',
      description: `[${result.domain}] ${scope} for ${projectId}`,
      input: { scope, projectId },
      parentTaskId,
      projectId,
    });
    completeTask(task.id, { text: result.text }, result.inputTokens + result.outputTokens, result.costUsd);
  }

  const totalDuration = Date.now() - startTime;

  console.log(`\n[Perspectives] Review complete: ${results.length}/${perspectives.length} succeeded`);
  console.log(`[Perspectives] Total cost: $${totalCost.toFixed(4)} | Duration: ${(totalDuration / 1000).toFixed(1)}s\n`);

  return {
    projectId,
    scope,
    perspectives: results,
    totalCostUsd: totalCost,
    totalDurationMs: totalDuration,
    timestamp: Date.now(),
  };
}

/**
 * Execute a single perspective — one LLM call with the perspective's system prompt.
 */
async function executePerspective(
  perspective: Perspective,
  projectId: string,
  scope: string,
  context: Record<string, unknown>,
): Promise<PerspectiveResult> {
  const startTime = Date.now();

  // Budget check
  const estimated = estimateCost(perspective.model, 5000, 4000);
  try {
    assertBudget(`perspective:${perspective.id}`, estimated);
  } catch {
    // If perspective-specific budget not set, try under generic 'perspectives' cap
    assertBudget('perspectives', estimated);
  }

  // Filter context to only fields relevant to this perspective's domain
  const filteredContext = filterContextForPerspective(context, perspective.domain);

  const prompt = `You are conducting a ${scope} of the project "${projectId}".

Context:
${JSON.stringify(filteredContext)}

Produce your analysis from the ${perspective.domain} perspective. Follow the PROBLEM + SOLUTION format:
- For every finding: PROBLEM (what is wrong, with evidence) + SOLUTION (concrete steps to fix)
- If something is already addressed, say "ALREADY ADDRESSED: [evidence]"
- Focus on what blocks the next milestone, not theoretical concerns
- Be specific. File paths, line numbers, concrete actions.
- If you are uncertain about something, explicitly state "ASSUMPTION: [what you're assuming]"
- If you need more information, state "I NEED TO KNOW: [specific question]"
- Do not guess confidently when you lack context — flag it clearly
- Maximum 1500 words.`;

  const result = await callModelUltra(prompt, perspective.model, perspective.systemPrompt);

  const costUsd = estimateCost(perspective.model, result.inputTokens, result.outputTokens);
  const durationMs = Date.now() - startTime;

  // Record spend
  recordSpend(`perspective:${perspective.id}`, result.inputTokens, result.outputTokens, costUsd, projectId);

  // Update perspective stats
  recordPerspectiveInvocation(perspective.id, projectId, costUsd);

  writeAudit({
    agent: `perspective:${perspective.id}`,
    taskId: 'review',
    action: 'task_completed',
    payload: { projectId, scope, costUsd, durationMs, tokens: result.inputTokens + result.outputTokens },
    outcome: 'success',
  });

  return {
    perspectiveId: perspective.id,
    domain: perspective.domain,
    text: result.text,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd,
    durationMs,
  };
}
