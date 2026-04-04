/**
 * Agent Runner — the polling loop that dispatches pending tasks to concrete agent implementations.
 *
 * This is the engine that makes Organism work. Without this running, tasks sit in the DB forever.
 *
 * Two modes:
 * 1. Daemon: startDaemon(intervalMs) — polls continuously (production use)
 * 2. One-shot: dispatchPendingTasks() — dispatch once and return (tests, scripts)
 */

import { getPendingTasks } from './task-queue.js';
import { BaseAgent } from '../../../agents/_base/agent.js';

// Concrete agent implementations — add each new agent here as it's built.
// The key must match the `owner` field in capability-registry.json.
import CeoAgent from '../../../agents/ceo/agent.js';
import ProductManagerAgent from '../../../agents/product-manager/agent.js';
import QualityAgent from '../../../agents/quality/quality-agent/agent.js';
import GrillMeAgent from '../../../agents/quality/grill-me/agent.js';
import EngineeringAgent from '../../../agents/engineering/agent.js';
import MarketingExecutorAgent from '../../../agents/marketing-executor/agent.js';
import SeoAgent from '../../../agents/seo/agent.js';
import DesignAgent from '../../../agents/design/agent.js';
import DevOpsAgent from '../../../agents/devops/agent.js';
import CodexReviewAgent from '../../../agents/quality/codex-review/agent.js';
import QualityGuardianAgent from '../../../agents/quality/quality-guardian/agent.js';
import CfoAgent from '../../../agents/cfo/agent.js';
import LegalAgent from '../../../agents/legal/agent.js';
import SalesAgent from '../../../agents/sales/agent.js';
import CtoAgent from '../../../agents/cto/agent.js';
import HrAgent from '../../../agents/hr/agent.js';
import CustomerSuccessAgent from '../../../agents/customer-success/agent.js';
import MedicalContentReviewerAgent from '../../../agents/medical-content-reviewer/agent.js';
import DataAnalystAgent from '../../../agents/data-analyst/agent.js';
import SecurityAuditAgent from '../../../agents/security-audit/agent.js';
import MarketingStrategistAgent from '../../../agents/marketing-strategist/agent.js';
import PrCommsAgent from '../../../agents/pr-comms/agent.js';
import CommunityManagerAgent from '../../../agents/community-manager/agent.js';

type AgentConstructor = new () => BaseAgent;

// Registry: agent name → implementation class.
// Key must match the `owner` field in knowledge/capability-registry.json.
const AGENT_MAP: Record<string, AgentConstructor> = {
  'ceo': CeoAgent,
  'product-manager': ProductManagerAgent,
  'quality-agent': QualityAgent,
  'grill-me': GrillMeAgent,
  'engineering': EngineeringAgent,
  'marketing-executor': MarketingExecutorAgent,
  'seo': SeoAgent,
  'design': DesignAgent,
  'devops': DevOpsAgent,
  'codex-review': CodexReviewAgent,
  'quality-guardian': QualityGuardianAgent,
  'cfo': CfoAgent,
  'legal': LegalAgent,
  'sales': SalesAgent,
  'cto': CtoAgent,
  'hr': HrAgent,
  'customer-success': CustomerSuccessAgent,
  'medical-content-reviewer': MedicalContentReviewerAgent,
  'data-analyst': DataAnalystAgent,
  'security-audit': SecurityAuditAgent,
  'marketing-strategist': MarketingStrategistAgent,
  'pr-comms': PrCommsAgent,
  'community-manager': CommunityManagerAgent,
};

/**
 * Dispatch all pending tasks to their registered agent implementations.
 * Runs each agent's full pending queue sequentially per agent.
 * Multiple distinct agents run sequentially (could be parallelized in a future iteration).
 */
export async function dispatchPendingTasks(): Promise<number> {
  const pending = getPendingTasks();
  if (pending.length === 0) return 0;

  // Unique agent names with pending tasks
  const agentNames = [...new Set(pending.map((t) => t.agent))];
  let dispatched = 0;

  for (const agentName of agentNames) {
    const AgentClass = AGENT_MAP[agentName];
    if (!AgentClass) {
      console.warn(`[Runner] No implementation registered for '${agentName}'. Add it to AGENT_MAP in agent-runner.ts.`);
      continue;
    }
    const agent = new AgentClass();
    await agent.run();
    dispatched++;
  }

  return dispatched;
}

/**
 * Start continuous polling daemon.
 * @param intervalMs - polling interval (default 10s)
 * @returns interval handle — call clearInterval(handle) to stop
 */
export function startDaemon(intervalMs = 10_000): ReturnType<typeof setInterval> {
  console.log(`[Runner] Daemon started — polling every ${intervalMs / 1000}s`);
  console.log(`[Runner] Registered agents: ${Object.keys(AGENT_MAP).join(', ')}`);

  // Dispatch immediately, then on interval
  dispatchPendingTasks().catch(console.error);

  return setInterval(() => {
    dispatchPendingTasks().catch(console.error);
  }, intervalMs);
}
