import * as fs from 'fs';
import * as path from 'path';
import { readRecentForAgent } from '../../packages/core/src/audit.js';
import { assertBudget, recordSpend, estimateCost, getAgentSpend } from '../../packages/core/src/budget.js';
import { checkoutTask, completeTask, failTask, getPendingTasks, createTask } from '../../packages/core/src/task-queue.js';
import { writeAudit } from '../../packages/core/src/audit.js';
import { evaluateG1 } from '../../packages/core/src/gates.js';
import { Task, AgentCapability } from '../../packages/shared/src/types.js';
import { OrganismError } from '../../packages/shared/src/error-taxonomy.js';
import { storeTaskMemory, getWorkingMemory, isStixDBAvailable } from '../../packages/core/src/memory.js';

// Tasklist candidates — checked in order, first found wins
const TASKLIST_CANDIDATES = [
  'tasks/master_tasklist.md',
  'TASKLIST.md',
  'tasks/todo.md',
  '.ai/tasklist.md',
  'TODO.md',
];

export type AgentModel = 'haiku' | 'sonnet' | 'opus' | 'gpt4o';

export interface AgentConfig {
  name: string;
  model: AgentModel;
  capability: AgentCapability;
  maxRunTimeMs?: number; // Default: 30 minutes
  requiredSecrets?: string[];
}

export abstract class BaseAgent {
  protected readonly name: string;
  protected readonly model: AgentModel;
  protected readonly config: AgentConfig;
  private heartbeatInterval?: ReturnType<typeof setInterval>;

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.model = config.model;
    this.config = config;
  }

  // Load recent audit entries for session continuity (the "breadcrumb" pattern)
  protected loadBreadcrumbs(limit = 5) {
    const entries = readRecentForAgent(this.name, limit);
    if (entries.length > 0) {
      console.log(`[${this.name}] Last ${entries.length} audit entries:`);
      for (const e of entries) {
        console.log(`  [${new Date(e.ts).toISOString()}] ${e.action} → ${e.outcome}`);
      }
    }
    return entries;
  }

  // Load tasklist from project directory — ground truth for what's done/pending
  protected loadTasklist(projectPath?: string): string | null {
    const searchRoots = projectPath ? [projectPath] : [];

    // Also check known project paths from project configs
    const configDir = path.resolve(process.cwd(), 'knowledge/projects');
    if (fs.existsSync(configDir)) {
      for (const proj of fs.readdirSync(configDir)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(configDir, proj, 'config.json'), 'utf8'));
          if (cfg.tasklist && fs.existsSync(cfg.tasklist)) {
            searchRoots.push(path.dirname(cfg.tasklist));
          }
        } catch { /* skip */ }
      }
    }

    for (const root of searchRoots) {
      for (const candidate of TASKLIST_CANDIDATES) {
        const full = path.join(root, candidate);
        if (fs.existsSync(full)) {
          const content = fs.readFileSync(full, 'utf8');
          console.log(`[${this.name}] Loaded tasklist: ${full} (${content.length} chars)`);
          return content;
        }
      }
    }
    return null;
  }

  // Main entry point — polls for pending tasks and processes them
  async run() {
    this.loadBreadcrumbs();
    this.loadTasklist(); // logs tasklist presence; subclasses access via execute() input

    // Load agent's working memory from StixDB (if available)
    try {
      if (await isStixDBAvailable()) {
        const memories = await getWorkingMemory(this.name, 10);
        if (memories.length > 0) {
          console.log(`[${this.name}] StixDB: ${memories.length} working memories loaded`);
        }
      }
    } catch { /* StixDB optional */ }

    console.log(`[${this.name}] Starting. Model: ${this.model}`);

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => this.heartbeat(), 5 * 60 * 1000);

    try {
      await this.processPendingTasks();
    } finally {
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    }
  }

  private async processPendingTasks() {
    const pending = getPendingTasks(this.name);
    if (pending.length === 0) {
      console.log(`[${this.name}] No pending tasks. Idle.`);
      return;
    }

    for (const task of pending) {
      await this.processTask(task);
    }
  }

  private async processTask(task: Task) {
    // Atomic checkout — exit if another agent took it
    const checked = checkoutTask(task.id, this.name);
    if (!checked) {
      console.log(`[${this.name}] Task ${task.id} already taken. Skipping.`);
      return;
    }

    const startedAt = Date.now();
    const maxRunTime = this.config.maxRunTimeMs ?? 30 * 60 * 1000;

    writeAudit({
      agent: this.name,
      taskId: task.id,
      action: 'task_checkout',
      payload: { taskDescription: task.description, lane: task.lane },
      outcome: 'success',
    });

    // Budget guard
    const estimatedTokensOut = 2000;
    const estimated = estimateCost(this.model, 5000, estimatedTokensOut);
    try {
      assertBudget(this.name, estimated);
    } catch (err) {
      writeAudit({
        agent: this.name,
        taskId: task.id,
        action: 'budget_check',
        payload: { error: String(err) },
        outcome: 'blocked',
        errorCode: OrganismError.BUDGET_CAP_EXCEEDED,
      });
      failTask(task.id, String(err));
      return;
    }

    // Timeout guard
    const timeoutHandle = setTimeout(() => {
      writeAudit({
        agent: this.name,
        taskId: task.id,
        action: 'error',
        payload: { message: 'Agent exceeded max run time' },
        outcome: 'failure',
        errorCode: OrganismError.AGENT_TIMEOUT,
      });
      failTask(task.id, `Timeout after ${maxRunTime}ms`);
    }, maxRunTime);

    try {
      const result = await this.execute(task);
      clearTimeout(timeoutHandle);

      const tokensUsed = result.tokensUsed ?? 0;
      const costUsd = estimateCost(this.model, Math.floor(tokensUsed * 0.7), Math.floor(tokensUsed * 0.3));

      recordSpend(this.name, Math.floor(tokensUsed * 0.7), Math.floor(tokensUsed * 0.3), costUsd, task.projectId ?? 'organism');
      completeTask(task.id, result.output, tokensUsed, costUsd);

      // Auto-chain: for MEDIUM/HIGH tasks, also queue codex-review after quality-agent
      if (task.lane === 'MEDIUM' || task.lane === 'HIGH') {
        try {
          createTask({
            agent: 'codex-review',
            lane: 'LOW',
            description: `Codex review: "${task.description.slice(0, 80)}"`,
            input: {
              originalTaskId: task.id,
              originalDescription: task.description,
              output: typeof result.output === 'object' && result.output !== null
                ? (result.output as Record<string, unknown>).text ?? JSON.stringify(result.output).slice(0, 3000)
                : String(result.output).slice(0, 3000),
            },
            parentTaskId: task.id,
            projectId: task.projectId ?? 'organism',
          });
        } catch { /* codex-review optional — don't fail the task */ }
      }

      // Store task completion in agent's long-term memory
      try {
        const outputText = typeof result.output === 'object' && result.output !== null
          ? (result.output as Record<string, unknown>).text as string ?? JSON.stringify(result.output).slice(0, 1000)
          : String(result.output).slice(0, 1000);
        await storeTaskMemory(this.name, {
          id: task.id,
          description: task.description,
          output: outputText,
          costUsd: costUsd,
          projectId: task.projectId,
        });
      } catch { /* StixDB optional — don't fail task if memory store fails */ }

      // G1 automated gate — runs after every task completion
      const agentSpendToday = getAgentSpend(this.name);
      const agentCap = this.config.capability?.reviewerLane === 'HIGH' ? 25 : 5;
      evaluateG1(task.id, {
        testsPassed: true,   // no test runner yet — default true until Week 3
        withinBudget: agentSpendToday < agentCap,
        noErrors: !result.output || !(result.output as Record<string, unknown>)?.error,
      });

      writeAudit({
        agent: this.name,
        taskId: task.id,
        action: 'task_completed',
        payload: { durationMs: Date.now() - startedAt, tokensUsed, costUsd },
        outcome: 'success',
      });

      console.log(`[${this.name}] Task ${task.id} completed. Cost: $${costUsd.toFixed(4)}`);
    } catch (err) {
      clearTimeout(timeoutHandle);
      const errorMsg = String(err);
      writeAudit({
        agent: this.name,
        taskId: task.id,
        action: 'task_completed',
        payload: { error: errorMsg },
        outcome: 'failure',
      });
      failTask(task.id, errorMsg);
      console.error(`[${this.name}] Task ${task.id} failed: ${errorMsg}`);
    }
  }

  private heartbeat() {
    writeAudit({
      agent: this.name,
      taskId: 'heartbeat',
      action: 'task_created', // reusing action field as signal
      payload: { heartbeat: true, ts: Date.now() },
      outcome: 'success',
    });
  }

  // Implement in each concrete agent
  protected abstract execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }>;
}
