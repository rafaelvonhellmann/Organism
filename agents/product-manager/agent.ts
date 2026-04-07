import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import { createPitch, markPitchReady, createBet } from '../../packages/core/src/shapeup.js';

const PM_SYSTEM = `You are the Product Manager for Organism. You own product requirements, feature specs, and backlog prioritization.

Your outputs:
- PRD (Product Requirements Document): problem → success metrics → requirements → non-requirements → open questions
- User stories: As a [user], I want [action] so that [outcome]. Acceptance criteria: [list].
- Feature prioritization: RICE score (Reach × Impact × Confidence / Effort), ranked list with rationale.
- Sprint planning: given a goal, break it into executable tasks for Engineering and Design.

Current products:
- Synapse: ANZCA/ACEM/CICM primary exam prep. Modes: MCQ, SAQ (photo grading), VIVA (voice). Rafael is the domain expert.
- Tokens for Good: TBD — await Rafael's definition.

Hard rules:
- Every feature must solve a stated user problem. No features without problems.
- Always include non-requirements (what we are explicitly NOT building).
- Be terse. A PRD is a decision tool, not a novel.
- Flag any assumption that Rafael needs to validate.`;

export default class ProductManagerAgent extends BaseAgent {
  constructor() {
    super({
      name: 'product-manager',
      model: 'sonnet',
      capability: {
        id: 'product.prd',
        owner: 'product-manager',
        collaborators: ['ceo', 'engineering', 'design'],
        reviewerLane: 'MEDIUM',
        description: 'Product requirements documents, feature specifications, user stories',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'daily',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    // ── [SHAPING] tasks: PM shapes a pitch for MEDIUM/HIGH tasks ──
    if (task.description.startsWith('[SHAPING]')) {
      return this.executeShaping(task);
    }

    const prompt = `Complete the following product management task.

Task: ${task.description}

Context:
${JSON.stringify(task.input)}

Produce the requested output directly. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', PM_SYSTEM);

    return {
      output: { text: result.text },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }

  private async executeShaping(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const originalDescription = task.description.replace(/^\[SHAPING\]\s*/, '');
    const input = task.input as Record<string, unknown> | null;

    const shapingPrompt = `You are shaping a pitch for a task that was classified as MEDIUM or HIGH risk and needs an approved bet before execution.

Original task description:
${originalDescription}

${input ? `Additional context:\n${JSON.stringify(input, null, 2)}` : ''}

Create a Shape Up pitch with the following fields. Output ONLY valid JSON, no markdown fences, no preamble:
{
  "title": "Short descriptive title for the bet",
  "problem": "Clear problem statement — what user/system problem does this solve?",
  "appetite": "small batch" or "big batch" — how much time/budget should be invested,
  "no_gos": ["things explicitly out of scope — at least 2"],
  "rabbit_holes": ["known complexity traps to avoid — at least 1"],
  "success_criteria": ["measurable criteria for done — at least 2"]
}`;

    const result = await callModelUltra(shapingPrompt, 'sonnet', PM_SYSTEM);
    const tokensUsed = result.inputTokens + result.outputTokens;

    // Parse LLM output into pitch fields
    let shaped: {
      title: string;
      problem: string;
      appetite: string;
      no_gos: string[];
      rabbit_holes: string[];
      success_criteria: string[];
    };

    try {
      shaped = JSON.parse(result.text.trim());
    } catch {
      // If JSON parsing fails, create a minimal pitch from the raw text
      shaped = {
        title: originalDescription.slice(0, 80),
        problem: originalDescription,
        appetite: 'small batch',
        no_gos: [],
        rabbit_holes: [],
        success_criteria: ['Task completes successfully'],
      };
    }

    // Create a pitch in the database
    const pitch = createPitch({
      title: shaped.title,
      problem: shaped.problem,
      appetite: shaped.appetite,
      rabbit_holes: JSON.stringify(shaped.rabbit_holes ?? []),
      no_gos: JSON.stringify(shaped.no_gos ?? []),
      shaped_by: 'product-manager',
      project_id: task.projectId ?? 'organism',
    });

    // Mark it ready for Rafael's review
    markPitchReady(pitch.id);

    // Also create a bet from this pitch so it appears in the bets dashboard
    const bet = createBet({
      pitch_id: pitch.id,
      title: shaped.title,
      problem: shaped.problem,
      appetite: shaped.appetite,
      shaped_by: 'product-manager',
      no_gos: JSON.stringify(shaped.no_gos ?? []),
      rabbit_holes: JSON.stringify(shaped.rabbit_holes ?? []),
      success_criteria: JSON.stringify(shaped.success_criteria ?? []),
      project_id: task.projectId ?? 'organism',
    });

    // Transition bet to pitch_ready so Rafael can approve/reject from dashboard
    const db = (await import('../../packages/core/src/task-queue.js')).getDb();
    db.prepare(`UPDATE bets SET status = 'pitch_ready', updated_at = ? WHERE id = ?`).run(Date.now(), bet.id);

    return {
      output: {
        text: `Pitch shaped and ready for review.`,
        type: 'shaping_complete',
        pitchId: pitch.id,
        betId: bet.id,
        title: shaped.title,
        problem: shaped.problem,
        appetite: shaped.appetite,
        noGos: shaped.no_gos,
        rabbitHoles: shaped.rabbit_holes,
        successCriteria: shaped.success_criteria,
        status: 'pitch_ready',
        originalTask: originalDescription,
      },
      tokensUsed,
    };
  }
}
