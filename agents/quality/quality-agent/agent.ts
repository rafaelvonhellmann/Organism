import { BaseAgent } from '../../_base/agent.js';
import { callModelUltra } from '../../_base/mcp-client.js';
import { Task } from '../../../packages/shared/src/types.js';
import { getTask, createTask, completeTask, countRevisions, getRevisionChainCost } from '../../../packages/core/src/task-queue.js';
import { writeAudit } from '../../../packages/core/src/audit.js';
import { triggerG4Gate } from '../../../packages/core/src/gates.js';
import { MAX_REVISIONS, REVISION_COST_CAP } from '../../../packages/core/src/budget.js';
import { buildRepoReviewBrief } from '../../../packages/core/src/repo-review-brief.js';
import { loadProjectPolicy } from '../../../packages/core/src/project-policy.js';

const QA_SYSTEM = `You are the Quality Agent for Organism. You review outputs from other agents using the autoresearch method.

Method: for every output you review, generate 3 alternative approaches, score each out of 10, identify the best, and give a final verdict.

Output format (strictly follow this):
## Quality Review

**Decision:** APPROVED | NEEDS_REVISION

**Score:** X/10

**Task:** [restate the original task in one line]

**Approaches considered:**
1. [approach name] — Score: X/10 — [one sentence rationale]
2. [approach name] — Score: X/10 — [one sentence rationale]
3. [approach name] — Score: X/10 — [one sentence rationale]

**Actual output assessment:** [2-3 sentences — how does the actual output compare to the alternatives?]

**Issues (if any):**
- [specific issue, or "None"]

**Verdict:** [one sentence — APPROVED or what specifically needs revision]

Rules:
- Score honestly. A 10/10 means nothing could be better.
- NEEDS_REVISION only if a specific, actionable improvement is identified.
- Be terse. The review itself should not exceed 300 words.`;

const CANARY_REVIEW_SYSTEM = `You are the Quality Agent for Organism running a first-canary project review.

Your job is not to review another agent's output. Your job is to inspect the supplied repo brief and decide whether Organism can safely operate on this project in stabilization mode.

Review principles:
- Focus on the biggest blockers to safe autonomous work
- Distinguish project problems from Organism/runtime problems
- Prefer evidence over speculation
- If evidence is missing, say so clearly
- Keep the output useful for a founder deciding whether to proceed
- Mark only LOW or MEDIUM findings as "actionable": true when they are safe for autonomous follow-up inside stabilization mode
- Mark HIGH findings as "actionable": false unless the follow-up is purely read-only validation

Return ONLY valid JSON with this exact shape:
{
  "summary": "1-2 sentence verdict",
  "decision": "APPROVED" | "NEEDS_REVISION",
  "score": 0,
  "review": "## Canary Review\\n...",
  "nextSteps": ["step 1", "step 2"],
  "findings": [
    {
      "id": "finding-1",
      "severity": "HIGH" | "MEDIUM" | "LOW",
      "summary": "what matters most",
      "evidence": "why you believe this",
      "remediation": "concrete next step",
      "actionable": false,
      "targetCapability": "engineering.code" | "product.prd" | "security-audit" | "quality.review",
      "followupKind": "implement" | "plan" | "validate" | "review"
    }
  ]
}`;

interface CanaryReviewResponse {
  summary: string;
  decision: 'APPROVED' | 'NEEDS_REVISION';
  score: number;
  review: string;
  nextSteps: string[];
  findings: Array<{
    id: string;
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
    summary: string;
    evidence?: string;
    remediation?: string;
    actionable?: boolean;
    targetCapability?: string;
    followupKind?: 'implement' | 'plan' | 'validate' | 'review';
  }>;
}

function isProjectRepoReview(task: Task, input: Record<string, unknown>): boolean {
  if (task.workflowKind !== 'review') return false;
  if (typeof input.reviewScope === 'string' && input.reviewScope === 'project') return true;
  if (input.canaryPreset === true) return true;
  return !input.originalTaskId;
}

function normalizeCanaryReviewResponse(
  projectId: string,
  taskDescription: string,
  rawText: string,
): CanaryReviewResponse {
  try {
    const parsed = JSON.parse(rawText.trim()) as Partial<CanaryReviewResponse>;
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : `Canary review completed for ${projectId}.`,
      decision: parsed.decision === 'APPROVED' ? 'APPROVED' : 'NEEDS_REVISION',
      score: typeof parsed.score === 'number' ? parsed.score : 6,
      review: typeof parsed.review === 'string' ? parsed.review : rawText.trim(),
      nextSteps: Array.isArray(parsed.nextSteps)
        ? parsed.nextSteps.filter((step): step is string => typeof step === 'string').slice(0, 5)
        : [],
      findings: Array.isArray(parsed.findings)
        ? parsed.findings
          .filter((finding): finding is CanaryReviewResponse['findings'][number] => !!finding && typeof finding === 'object' && typeof finding.summary === 'string')
          .slice(0, 5)
          .map((finding, index) => ({
            id: typeof finding.id === 'string' ? finding.id : `canary-${projectId}-${index + 1}`,
            severity: finding.severity === 'HIGH' || finding.severity === 'LOW' ? finding.severity : 'MEDIUM',
            summary: finding.summary,
            evidence: typeof finding.evidence === 'string' ? finding.evidence : undefined,
            remediation: typeof finding.remediation === 'string' ? finding.remediation : undefined,
            actionable: (finding.severity === 'MEDIUM' || finding.severity === 'LOW')
              && typeof finding.remediation === 'string'
              && finding.remediation.trim().length > 0
              ? (typeof finding.actionable === 'boolean' ? finding.actionable : true)
              : false,
            targetCapability: typeof finding.targetCapability === 'string'
              ? (finding.followupKind === 'implement' && finding.targetCapability === 'quality.review'
                ? 'engineering.code'
                : finding.targetCapability)
              : undefined,
            followupKind: finding.followupKind,
          }))
        : [],
    };
  } catch {
    return {
      summary: `Canary review completed for ${projectId}.`,
      decision: 'NEEDS_REVISION',
      score: 5,
      review: `## Canary Review\n\n**Task:** ${taskDescription}\n\n${rawText.trim()}`,
      nextSteps: [],
      findings: [],
    };
  }
}

export default class QualityAgent extends BaseAgent {
  constructor() {
    super({
      name: 'quality-agent',
      model: 'sonnet',
      capability: {
        id: 'quality.review',
        owner: 'quality-agent',
        collaborators: [],
        reviewerLane: 'LOW',
        description: 'Autoresearch quality review — generates 3+ approaches and scores them',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const projectId = task.projectId ?? (typeof input?.projectId === 'string' ? input.projectId : 'organism');

    if (isProjectRepoReview(task, input)) {
      return this.executeProjectCanaryReview(task, projectId, input);
    }

    const rawOutput = (input?.output as string) ?? '';
    // Cap review payload at ~2K tokens to control cost — quality-agent is a lightweight gate
    const originalOutput = rawOutput.slice(0, 4000);
    const originalDesc = (input?.originalDescription as string) ?? task.description;
    const originalTaskId = (input?.originalTaskId as string) ?? '';

    // Batch reviews use Haiku (cheap triage); single reviews use Sonnet
    const isBatchReview = task.description.startsWith('Batch quality review');
    const model = isBatchReview ? 'haiku' : 'sonnet';

    const prompt = `Review the following agent output.

Original task: ${originalDesc}

Output to review:
---
${originalOutput}
---

Apply the autoresearch method: generate 3 alternative approaches, score the actual output against them, and give your verdict.`;

    const result = await callModelUltra(prompt, model as 'haiku' | 'sonnet' | 'opus', QA_SYSTEM);

    const approved = result.text.includes('**Decision:** APPROVED') ||
                     result.text.includes('Decision: APPROVED');

    // For HIGH-lane parent tasks: trigger G4 board gate instead of auto-ship
    if (originalTaskId) {
      const parentTask = getTask(originalTaskId);
      if (parentTask?.lane === 'HIGH' && approved) {
        triggerG4Gate(
          originalTaskId,
          `Quality review APPROVED.\n\nOriginal task: ${originalDesc}\n\nReview summary:\n${result.text.slice(0, 600)}`
        );
      }

      // AUTO-APPROVAL: LOW-lane tasks that pass quality review skip Rafael's review queue.
      // They are auto-completed with an audit trail so we can track them.
      // MEDIUM and HIGH always require human review.
      if (parentTask?.lane === 'LOW' && approved) {
        try {
          // Only auto-complete if the parent task is still in a completable state
          // (awaiting_review or completed but not yet decided on)
          if (parentTask.status === 'awaiting_review' || parentTask.status === 'completed') {
            completeTask(parentTask.id, parentTask.output, parentTask.tokensUsed ?? 0, parentTask.costUsd ?? 0);
            console.log(`[quality-agent] AUTO-APPROVED LOW-lane task ${parentTask.id} (${parentTask.agent}: "${parentTask.description.slice(0, 60)}")`);
          }

          writeAudit({
            agent: 'quality-agent',
            taskId: parentTask.id,
            action: 'auto_approved',
            payload: {
              originalAgent: parentTask.agent,
              lane: parentTask.lane,
              qualityScore: result.text.match(/Score:\s*(\d+)/)?.[1] ?? 'unknown',
              reviewSummary: result.text.slice(0, 300),
            },
            outcome: 'success',
          });
        } catch (err) {
          console.warn(`[quality-agent] Failed to auto-approve LOW-lane task ${parentTask.id}: ${err}`);
        }
      }
    }

    // Quality feedback loop: if review contains CRITICAL/REJECT signals, create a
    // revision task for the original agent so it can address the feedback.
    if (!approved && originalTaskId) {
      const hasCritical = /\bCRITICAL\b|\bREJECT\b|\bREVISION NEEDED\b/i.test(result.text);
      if (hasCritical) {
        const parentTask = getTask(originalTaskId);
        if (parentTask) {
          const originalId = (task.input as Record<string, unknown>)?.originalTaskId as string ?? task.id;
          const revCount = countRevisions(originalId);
          const chainCost = getRevisionChainCost(originalId);
          if (revCount >= MAX_REVISIONS) {
            console.warn(`[quality-agent] Revision cap reached (${revCount}/${MAX_REVISIONS}) for ${originalId} — skipping`);
          } else if (chainCost >= REVISION_COST_CAP) {
            console.warn(`[quality-agent] Revision cost cap reached ($${chainCost.toFixed(2)}/$${REVISION_COST_CAP}) for ${originalId} — skipping`);
          } else {
            try {
              createTask({
                agent: parentTask.agent,
                lane: 'LOW', // revision is remediation, not a new risk
                description: `Revision needed: quality review flagged critical issues in "${parentTask.description.slice(0, 80)}"`,
                input: {
                  qualityFeedback: result.text,
                  originalTaskId,
                  originalDescription: parentTask.description,
                },
                parentTaskId: originalTaskId,
                projectId: parentTask.projectId ?? 'organism',
              });
              console.log(`[quality-agent] Revision task created for '${parentTask.agent}' (original task ${originalTaskId})`);
            } catch {
              // Duplicate detection may fire — safe to ignore
              console.warn(`[quality-agent] Could not create revision task for ${originalTaskId}`);
            }
          }
        }
      }
    }

    // AUTO-APPROVAL for batch reviews: each LOW-lane task in the batch gets an
    // auto_approved audit entry so the dashboard excludes them from the review queue.
    if (approved && !originalTaskId) {
      const batched = (input?.batchedOutputs as Array<{ taskId: string }>) ?? [];
      for (const item of batched) {
        if (!item.taskId) continue;
        try {
          const batchedTask = getTask(item.taskId);
          if (batchedTask?.lane === 'LOW') {
            writeAudit({
              agent: 'quality-agent',
              taskId: item.taskId,
              action: 'auto_approved',
              payload: {
                originalAgent: batchedTask.agent,
                lane: 'LOW',
                reviewType: 'batch',
                qualityScore: result.text.match(/Score:\s*(\d+)/)?.[1] ?? 'unknown',
              },
              outcome: 'success',
            });
          }
        } catch {
          // Non-critical — task may have been deleted or already processed
        }
      }
    }

    return {
      output: {
        review: result.text,
        decision: approved ? 'APPROVED' : 'NEEDS_REVISION',
        originalTaskId,
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }

  private async executeProjectCanaryReview(
    task: Task,
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<{ output: unknown; tokensUsed?: number }> {
    const policy = loadProjectPolicy(projectId);
    const repoBrief = buildRepoReviewBrief(projectId);

    const prompt = `Run a first-canary review for the project "${projectId}".

Task:
${task.description}

Policy:
${JSON.stringify({
      repoPath: policy.repoPath,
      defaultBranch: policy.defaultBranch,
      workspaceMode: policy.workspaceMode,
      autonomyMode: policy.autonomyMode,
      allowedActions: policy.allowedActions,
      blockedActions: policy.blockedActions,
      launchGuards: policy.launchGuards,
    }, null, 2)}

Repo brief:
${JSON.stringify(repoBrief, null, 2)}

Additional dashboard/task context:
${JSON.stringify(input, null, 2)}

Review what matters most for a safe first autonomous canary.
Cover:
- repo clarity and readiness
- biggest technical or operational blockers
- whether the project is suitable for review/implement/validate work right now
- the next 3 best actions`;

    const result = await callModelUltra(prompt, 'sonnet', CANARY_REVIEW_SYSTEM);
    const parsed = normalizeCanaryReviewResponse(projectId, task.description, result.text);
    const nextStepsMarkdown = parsed.nextSteps.length > 0
      ? `\n\n### Next Steps\n${parsed.nextSteps.map((step) => `- ${step}`).join('\n')}`
      : '';
    const canSeedValidationFollowup = parsed.decision === 'APPROVED'
      && policy.launchGuards.initialAllowedWorkflows.includes('validate');

    return {
      output: {
        kind: 'finding',
        summary: parsed.summary,
        review: parsed.review + nextStepsMarkdown,
        decision: parsed.decision,
        score: parsed.score,
        mode: 'project_review',
        projectId,
        findings: parsed.findings,
        handoffRequests: canSeedValidationFollowup
          ? [
              {
                id: `canary-validate-${projectId}`,
                targetAgent: 'engineering',
                workflowKind: 'validate',
                reason: 'Approved canary review should turn into concrete repo validation automatically.',
                summary: `Run bounded canary validation for ${projectId} and capture the next safe implementation blockers.`,
                execution: true,
              },
            ]
          : [],
        artifacts: [
          {
            kind: 'report' as const,
            title: `Canary review: ${projectId}`,
            content: parsed.review + nextStepsMarkdown,
          },
        ],
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
