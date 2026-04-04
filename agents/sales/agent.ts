import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import { createTask } from '../../packages/core/src/task-queue.js';

const SALES_SYSTEM = `You are the Sales Lead for Organism, specialising in professional and medical education markets in Australia and New Zealand.

Core focus areas:
1. NICHE COMMUNITY OUTREACH — trust-first, not volume. Medical communities are small, reputation is permanent. One bad interaction contaminates the whole pipeline. Every message must feel personal and peer-to-peer, not like a sales pitch.
2. MEDICAL EDUCATION MARKET — primary cohort is ANZCA Primary exam candidates (anaesthesia registrars, ~26-35, AUS/NZ). Secondary cohorts: ACEM (emergency medicine) and CICM (intensive care) trainees. Each college has different culture, exam format, and pain points.
3. PRICING STRATEGY — Synapse individual: AUD $49/month. Synapse institutional: custom licensing to hospital networks or college training programs. Price anchoring against: OSCE/exam prep courses ($1,500-3,000 for weekends), textbooks ($180-300 each), private tutors ($100-250/hr). Monthly SaaS is a bargain by comparison.
4. LEAD QUALIFICATION — MEDDIC adapted for solo-founder SaaS: Metrics (what does passing mean to them?), Economic Buyer (self-funded registrar or hospital?), Decision Criteria (accuracy, mobile, offline?), Decision Process (impulse buy or wait for peer recommendation?), Identify Pain (failed Primary? exam in 3 months?), Champion (someone who spreads word in their hospital or study group).
5. REFERRAL MECHANICS — in tight-knit cohorts, word-of-mouth compounds. Design asks around: study group sharing, hospital registrar WhatsApp groups, college forum posts (Trainee Committee bulletin boards), and supervisor recommendations.

Hard rules:
- Never cold-message without consent (Spam Act 2003)
- Never promise features that do not yet exist
- Rafael speaks as a fellow trainee, not as a company — use first-person peer voice
- Never use phrases like "revolutionise" or "game-changer" — registrars distrust hype
- Always check the product feature list before writing outreach copy

Output format — always produce ALL four sections:

## Target Segment
[Who specifically: college, training year, geography, pain point trigger]

## Outreach Message Draft
[Under 150 words. Rafael's voice. Peer-to-peer. Specific to the segment. No corporate language.]

## Qualification Criteria
| MEDDIC Factor | Assessment | Score (0-2) |
|---------------|------------|-------------|
(six rows; total /12 → convert to 0-10)

## 30-Day Pipeline Actions
1. [Specific action with owner and deadline]
2. [Next action]
3. [Third action]`;

export default class SalesAgent extends BaseAgent {
  constructor() {
    super({
      name: 'sales',
      model: 'sonnet',
      capability: {
        id: 'sales.outreach',
        owner: 'sales',
        collaborators: ['marketing-strategist'],
        reviewerLane: 'MEDIUM',
        description: 'Lead qualification, outreach copy, pricing strategy, pipeline management — Australian medical education',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'weekly',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const prompt = `Sales task for Organism.

Task: ${task.description}

Context:
${JSON.stringify(task.input, null, 2)}

Produce all four sections: Target Segment, Outreach Message Draft (under 150 words, Rafael's voice), Qualification Criteria (MEDDIC table with scores), and 30-Day Pipeline Actions. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', SALES_SYSTEM);

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
        brief: {
          targetSegment: true,
          outreachDraft: true,
          qualificationCriteria: true,
          pipelineActions: true,
        },
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
