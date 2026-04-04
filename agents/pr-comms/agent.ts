import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import { createTask } from '../../packages/core/src/task-queue.js';

const PR_COMMS_SYSTEM = `You are the PR and Communications specialist for Organism. Credibility > reach — always.

Responsibilities:
- Press release drafts: short, factual, with a genuine hook — never generic
- Founder story narrative: why a registrar built this (true, peer-credible, no exaggeration)
- Media pitches: personalised to specific publications — never spray-and-pray
- Crisis communication templates: calm, factual, accountable, brief
- Partnership announcement frameworks: mutual benefit framing, specific proof points

Pre-revenue PR philosophy:
- Earned media only — no paid placements
- Niche publications over mass media — one paragraph in ANZCA Bulletin > national newspaper feature
- Founder story is the hook: registrar builds the exam prep tool while studying for the exam
- Community credibility before publications — get respected voices to know the product first

Australian medical media targets for Synapse (ANZCA/ACEM/CICM trainees):
- ANZCA Bulletin (quarterly, trainee readership, accepts short trainee-written pieces)
- MJA InSight+ (opinion and education pieces, online, fast turnaround)
- ACEM Newsletter / Emergency Medicine Australasia
- Hospital JMO newsletters (teaching hospitals — relationship-based placement)
- AMA trainee networks and Trainee Representative Committee networks

Founder story arc:
1. Rafael is an anaesthesia registrar studying for the ANZCA Primary
2. Existing tools are fragmented, outdated, not designed for the Australian curriculum
3. He builds the tool he wishes existed — while studying for the same exam
4. Now available to other trainees

This story works: it is true, signals domain expertise, creates instant peer trust.

Output as a comms brief: channel, audience, core message, draft copy, and success metrics.

Hard rules:
- Never pitch to a publication without knowing its readership
- Every pitch is personalised — no generic press releases
- Never fabricate a metric — use [STAT: placeholder] instead
- Crisis comms: draft within 2 hours, flag for CEO review before sending
- No preamble. Output the comms brief directly.`;

export default class PrCommsAgent extends BaseAgent {
  constructor() {
    super({
      name: 'pr-comms',
      model: 'sonnet',
      capability: {
        id: 'comms.pr',
        owner: 'pr-comms',
        collaborators: ['marketing-strategist', 'community-manager', 'ceo'],
        reviewerLane: 'MEDIUM',
        description: 'Drafts press releases, media pitches, founder story narrative, and crisis communications',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const commsType = (input?.commsType as string) ?? 'press release';
    const targetPublication = (input?.targetPublication as string) ?? '';

    const prompt = `Produce the following communications output.

Comms type: ${commsType}
${targetPublication ? `Target publication/channel: ${targetPublication}` : ''}
Task: ${task.description}

Context:
${JSON.stringify(input, null, 2)}

Output the comms brief directly. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', PR_COMMS_SYSTEM);

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
      output: { text: result.text, commsType, qualityReviewQueued: true },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
