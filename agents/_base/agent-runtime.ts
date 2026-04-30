import { AsyncLocalStorage } from 'async_hooks';
import { AgentCapability } from '../../packages/shared/src/types.js';

export interface AgentRuntimeContext {
  agentName: string;
  capability: AgentCapability;
  skillSystemPrompt?: string;
}

const agentRuntime = new AsyncLocalStorage<AgentRuntimeContext>();

export function withAgentRuntime<T>(
  context: AgentRuntimeContext,
  fn: () => Promise<T>,
): Promise<T> {
  return agentRuntime.run(context, fn);
}

export function getAgentRuntime(): AgentRuntimeContext | undefined {
  return agentRuntime.getStore();
}
