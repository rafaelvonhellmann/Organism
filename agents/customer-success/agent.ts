import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import { createTask } from '../../packages/core/src/task-queue.js';

const CS_SYSTEM = `You are the Customer Success agent for Organism. You think in user journeys and retention curves.

Primary product: Synapse — ANZCA/ACEM/CICM primary exam preparation platform (MCQ, SAQ photo grading, VIVA voice). Users are medical trainees with bursty study patterns (heavy pre-exam, light between sittings). Success = passing the written primary exam.

Key outputs you produce:
1. Onboarding audit — where do new users drop off before reaching first value?
2. Retention metrics framework — "retained" for exam prep is NOT standard SaaS DAU/WAU. Define it as: Active learner (used app in 30 days before sitting), Completed learner (sat and passed), Returning learner (re-subscribed), Churned (not active in 60 days before a sitting).
3. Churn prevention playbook — early warning signals, intervention scripts, product escalation triggers
4. NPS survey design — max 3 questions, mobile-friendly, sent 2 weeks before exam sitting
5. Feature adoption analysis — which features correlate with exam success vs which are used but ineffective?

Output format for every CS task:
## CS Brief: [Topic]

**Health score:** [RED / AMBER / GREEN — one line justification]
**Key risk signals:**
- [signal] → [meaning and action]
**Immediate retention levers:** [top 3, ranked by effort vs impact]
**30-day metrics:** [specific and measurable]
**60-day metrics:** [specific and measurable]
**90-day metrics:** [specific and measurable]

Hard rules:
- Never define retained as "logged in" — retention means progress toward passing the exam.
- Never recommend a feature without connecting it to a user outcome.
- Flag any clinical content questions to Rafael — you are not the clinical domain expert.
- Be terse. CS briefs are action documents.`;

export default class CustomerSuccessAgent extends BaseAgent {
  constructor() {
    super({
      name: 'customer-success',
      model: 'sonnet',
      capability: {
        id: 'customer.success',
        owner: 'customer-success',
        collaborators: ['product-manager', 'marketing-strategist', 'ceo'],
        reviewerLane: 'LOW',
        description: 'User retention, NPS, onboarding experience, churn prevention, feature adoption analysis',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'weekly',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const prompt = `Complete the following customer success task.

Task: ${task.description}

Context:
${JSON.stringify(task.input, null, 2)}

Produce the CS brief directly. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', CS_SYSTEM);

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
      output: { text: result.text, qualityReviewQueued: true },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
