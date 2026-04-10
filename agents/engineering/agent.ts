import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import * as fs from 'fs';
import { finalizeEngineeringExecution, prepareEngineeringWorkspace } from '../../packages/core/src/execution-controller.js';
import { runCodeExecutor } from '../../packages/core/src/code-executor.js';
import { loadProjectPolicy } from '../../packages/core/src/project-policy.js';

// HARD BLOCKS — tasks matching these patterns are REFUSED.
// Stabilization mode blocks contact and purchasing. Routine repo execution is controller-owned.
const BLOCKED_ACTION_PATTERNS = [
  /\b(send|email|notify|contact|message|reach out|dm|ping)\b.*\b(user|customer|patient|partner|investor|doctor|registrar)\b/i,
  /\b(post|publish|tweet|share)\b.*\b(social|facebook|twitter|linkedin|instagram|reddit|discord|slack)\b/i,
  /\b(purchase|buy|subscribe|pay|charge|invoice|billing)\b/i,
  /\b(sign up|register|create account)\b.*\b(service|platform|provider)\b/i,
  /\b(stripe|sendgrid|mailgun|twilio|mailchimp)\b/i,
];

function isBlockedAction(description: string): string | null {
  for (const pattern of BLOCKED_ACTION_PATTERNS) {
    if (pattern.test(description)) {
      return `BLOCKED: "${description}" matches safety rule. Organism cannot send emails, contact people, make purchases, or post to social media.`;
    }
  }
  return null;
}

const ENGINEERING_SYSTEM = `You are the Engineering Agent for Organism. You implement features, fix bugs, and write production-quality code.

Current mode: ACTIVE — you write and edit real code. The controller owns branching, verification, commits, pushes, PRs, and deploys.

How you work:
1. Read Grill-Me's scrutiny report (in grillMeScrutiny field) and address every blind spot
2. Plan before you code — identify what files change and why
3. Write complete implementations (not pseudocode) and edit the repo directly when execution mode is active
4. Write tests for any new behavior
5. Never perform git, GitHub, Vercel, account creation, outreach, or billing actions yourself

Output format — STRUCTURED so we can parse it:
## Engineering Implementation

**Task:** [one line]
**Approach:** [one sentence]
**Status:** ACTIVE — implementing

### Files to change
- \`path/to/file.ts\` — [what and why]

### Implementation
[Complete code for each changed file, wrapped in fenced code blocks with the file path as the language identifier]

\`\`\`path/to/file.ts
// complete file content or diff
\`\`\`

### Tests
[Specific test cases with inputs and expected outputs]

### Grill-Me blind spots addressed
- [each blind spot] → [how addressed in implementation]

Hard rules:
- No pseudocode. Write actual, runnable code.
- No hardcoded secrets — use environment variables or packages/shared/src/secrets.ts.
- Read existing code structure before changing anything.
- Address every Grill-Me concern explicitly.
- Do not create commits, push branches, open PRs, or deploy. The controller handles those steps.

Output rules:
- Lead with the most important finding or recommendation in plain English
- No technical codes (OWASP, CWE, CVE, NIST, ISO references) unless specifically relevant
- No system instructions or formatting directives in your output
- Write for a busy founder who has 30 seconds to read each assessment
- Structure: 1) Key finding (1-2 sentences) 2) Why it matters 3) What to do about it
- If nothing meaningful to report, say "No issues found" — don't pad with filler`;


export default class EngineeringAgent extends BaseAgent {
  constructor() {
    super({
      name: 'engineering',
      model: 'sonnet',
      capability: {
        id: 'engineering.code',
        owner: 'engineering',
        collaborators: ['devops', 'quality-agent'],
        reviewerLane: 'MEDIUM',
        description: 'Code writing, bug fixes, refactoring, technical implementation',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'always-on',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    // Safety check — refuse blocked actions
    const blocked = isBlockedAction(task.description);
    if (blocked) {
      return {
        output: {
          summary: blocked,
          implementation: blocked,
          mode: 'blocked',
          findings: [
            {
              id: `blocked-${task.id}`,
              severity: 'HIGH',
              summary: blocked,
              actionable: false,
              targetCapability: 'engineering.code',
              followupKind: 'recover',
            },
          ],
        },
        tokensUsed: 0,
      };
    }

    const input = task.input as Record<string, unknown>;
    const grillMeScrutiny = input?.grillMeScrutiny as string | undefined;
    const isExecution = input?.execution === true || input?.autoExecuted === true;
    const projectId = task.projectId ?? (input?.projectId as string) ?? 'organism';
    const policy = loadProjectPolicy(projectId);

    // If this is an execution task with a project path, use the configured code executor to implement
    if (isExecution && policy.repoPath && fs.existsSync(policy.repoPath)) {
      return this.executeWithExecutor(task, projectId);
    }

    // Otherwise, generate implementation plan (for tasks without clear execution context)
    const prompt = `Implement the following engineering task.

Task: ${task.description}

${grillMeScrutiny ? `Grill-Me scrutiny (address every blind spot and hard question):\n${grillMeScrutiny}\n` : ''}
Context:
${JSON.stringify(input)}

Produce a complete implementation plan with full code. Include specific file paths and complete implementations.`;

    const result = await callModelUltra(prompt, 'sonnet', ENGINEERING_SYSTEM);

    return {
      output: {
        summary: `Prepared an implementation plan for ${task.description.slice(0, 80)}`,
        implementation: result.text,
        mode: 'plan',
        handoffRequests: [
          {
            id: `verify-${task.id}`,
            targetAgent: 'quality-agent',
            workflowKind: 'validate',
            reason: 'Implementation plan prepared and should be validated before execution.',
            summary: `Validate engineering plan for ${task.description.slice(0, 80)}`,
            execution: false,
          },
        ],
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }

  /**
   * Execute code changes using the configured code executor in the project directory.
   * The controller prepares the branch, runs verification, and owns privileged actions.
   */
  private async executeWithExecutor(
    task: Task,
    projectId: string,
  ): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const sourceOutput = input?.sourceOutput as string | undefined;
    const workspace = prepareEngineeringWorkspace(task);

    try {
      const cliPrompt = `You are implementing a task for the Organism autonomous system.

TASK: ${task.description}

${sourceOutput ? `CONTEXT FROM PREVIOUS ANALYSIS:\n${sourceOutput.slice(0, 3000)}\n` : ''}

RULES:
- Make the minimum changes needed to complete the task
- Do NOT modify unrelated files
- Write actual code, not pseudocode
- If you need to create tests, do so
- Do NOT run git, gh, vercel, or account-management commands
- The controller already created the branch ${workspace.branchName}; stay on it and only edit code/tests/docs as needed
- NEVER send emails, post to social media, contact users, or make purchases
- NEVER run destructive commands (rm -rf, DROP TABLE, git reset --hard, etc.)

After making changes, output:
1. A concise summary of what you changed
2. The files you touched
3. What should be verified next by the controller.`;

      const result = await runCodeExecutor({
        cwd: workspace.projectPath,
        prompt: cliPrompt,
        maxTurns: 15,
      });

      const controllerSummary = finalizeEngineeringExecution(task, workspace);

      return {
        output: {
          summary: controllerSummary.changedFiles.length > 0
            ? `Implemented ${controllerSummary.changedFiles.length} file change(s) on ${controllerSummary.branch}`
            : `Reviewed ${projectId} but no file changes were made`,
          implementation: result.text,
          executor: result.executor,
          executorLog: result.rawOutput.slice(0, 8000),
          mode: 'executed',
          branch: controllerSummary.branch,
          changedFiles: controllerSummary.changedFiles,
          baselineDirty: controllerSummary.baselineDirty,
          verification: controllerSummary.verification,
          controllerActions: controllerSummary.controllerActions,
          commandProposals: controllerSummary.commandProposals,
          approvalRequests: controllerSummary.approvalRequests,
          artifacts: [
            {
              kind: 'patch',
              title: 'Workspace diff summary',
              content: controllerSummary.diffSummary,
            },
            ...controllerSummary.verification.map((step) => ({
              kind: 'verification' as const,
              title: `Verification ${step.action}`,
              content: `${step.ok ? 'PASS' : 'FAIL'}\n\n${step.output}`,
            })),
            ...controllerSummary.controllerActions.map((step) => ({
              kind: 'command_log' as const,
              title: `Controller action ${step.action}`,
              content: `${step.ok ? 'PASS' : 'FAIL'}\n\n${step.output}`,
            })),
          ],
          projectId,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        output: {
          summary: `Execution failed for ${projectId}: ${errorMsg.slice(0, 120)}`,
          implementation: `Execution failed: ${errorMsg}`,
          mode: 'failed',
          projectId,
          findings: [
            {
              id: `engineering-failure-${task.id}`,
              severity: 'HIGH',
              summary: 'Engineering execution failed before verification completed.',
              evidence: errorMsg.slice(0, 1000),
              remediation: 'Inspect the workspace and rerun the implementation after resolving the controller failure.',
              actionable: true,
              targetCapability: 'engineering.code',
              followupKind: 'recover',
            },
          ],
        },
      };
    }
  }
}
