/**
 * StixDB Memory Client
 *
 * Used by Organism agents to store and retrieve memories from the
 * StixDB graph-memory server running on localhost:4020.
 */

const STIXDB_URL = process.env.STIXDB_URL ?? 'http://localhost:4020';
const STIXDB_KEY = process.env.STIXDB_API_KEY ?? 'organism-stixdb-local';
const STIXDB_DEBUG = !!process.env.STIXDB_DEBUG;

// ── Types ──────────────────────────────────────────────────────────

export type NodeType = 'fact' | 'entity' | 'event' | 'concept' | 'procedure';

export interface StoreMemoryOptions {
  nodeType?: NodeType;
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  taskId?: string;
  projectId?: string;
}

export interface AskMemoryOptions {
  topK?: number;
  depth?: number;
}

export interface RetrieveOptions {
  topK?: number;
  depth?: number;
}

export interface AskResult {
  answer: string;
  confidence: number;
  isConfident: boolean;
  sources: Array<{ content: string; nodeId: string }>;
  reasoningTrace: string;
}

export interface MemoryNode {
  content: string;
  nodeId: string;
  importance: number;
}

export interface WorkingMemoryNode {
  content: string;
  nodeId: string;
}

export interface CrossAgentResult {
  content: string;
  agent: string;
  nodeId: string;
}

export interface TaskMemory {
  id: string;
  description: string;
  output: string;
  costUsd: number;
  projectId?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': STIXDB_KEY,
  };
}

async function post<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${STIXDB_URL}${path}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (STIXDB_DEBUG) console.warn(`[memory] POST ${path} → ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    if (STIXDB_DEBUG) console.warn(`[memory] StixDB unreachable (POST ${path}):`, (err as Error).message);
    return null;
  }
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${STIXDB_URL}${path}`, {
      method: 'GET',
      headers: headers(),
    });
    if (!res.ok) {
      if (STIXDB_DEBUG) console.warn(`[memory] GET ${path} → ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    if (STIXDB_DEBUG) console.warn(`[memory] StixDB unreachable (GET ${path}):`, (err as Error).message);
    return null;
  }
}

/** Collection name for an agent. */
function col(agent: string): string {
  return `agent-${agent}`;
}

// ── Public API ──────────────────────────────────────────────────────

/** Store a memory node for an agent. Returns the node_id or empty string on failure. */
export async function storeMemory(
  agent: string,
  content: string,
  options: StoreMemoryOptions = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    content,
    node_type: options.nodeType ?? 'fact',
    importance: options.importance ?? 0.5,
    tags: options.tags ?? [],
    metadata: {
      ...options.metadata,
      ...(options.taskId ? { task_id: options.taskId } : {}),
      ...(options.projectId ? { project_id: options.projectId } : {}),
    },
    source_agent_id: agent,
  };

  const res = await post<{ node_id: string }>(`/collections/${col(agent)}/nodes`, body);
  return res?.node_id ?? '';
}

/** Ask a question using LLM reasoning over an agent's memory. Costs money. */
export async function askMemory(
  agent: string,
  question: string,
  options: AskMemoryOptions = {},
): Promise<AskResult> {
  const empty: AskResult = {
    answer: '',
    confidence: 0,
    isConfident: false,
    sources: [],
    reasoningTrace: '',
  };

  const body = {
    question,
    top_k: options.topK ?? 10,
    depth: options.depth ?? 1,
  };

  const res = await post<{
    answer: string;
    confidence: number;
    is_confident: boolean;
    sources: Array<{ content: string; node_id: string }>;
    reasoning_trace: string;
  }>(`/collections/${col(agent)}/ask`, body);

  if (!res) return empty;

  return {
    answer: res.answer,
    confidence: res.confidence,
    isConfident: res.is_confident,
    sources: (res.sources ?? []).map((s) => ({ content: s.content, nodeId: s.node_id })),
    reasoningTrace: res.reasoning_trace,
  };
}

/** Retrieve raw memories without LLM cost. */
export async function retrieveMemories(
  agent: string,
  query: string,
  options: RetrieveOptions = {},
): Promise<MemoryNode[]> {
  const body = {
    query,
    top_k: options.topK ?? 10,
    depth: options.depth ?? 1,
  };

  const res = await post<{
    results: Array<{ content: string; node_id: string; importance: number }>;
    count: number;
  }>(`/collections/${col(agent)}/retrieve`, body);

  if (!res?.results) return [];

  return res.results.map((r) => ({
    content: r.content,
    nodeId: r.node_id,
    importance: r.importance,
  }));
}

/** Get working memory (hot nodes) for session start. */
export async function getWorkingMemory(
  agent: string,
  limit = 50,
): Promise<WorkingMemoryNode[]> {
  const res = await get<{
    results?: Array<{ content: string; node_id: string }>;
  }>(`/collections/${col(agent)}/agent/working-memory?limit=${limit}`);

  if (!res?.results) return [];

  return res.results.map((r) => ({ content: r.content, nodeId: r.node_id }));
}

/** Search across multiple agent collections. */
export async function searchAcrossAgents(
  query: string,
  agents: string[],
  maxResults = 20,
): Promise<CrossAgentResult[]> {
  const body = {
    query,
    collections: agents.map(col),
    max_results: maxResults,
    top_k: maxResults,
  };

  const res = await post<{
    results?: Array<{ content: string; node_id: string; collection: string }>;
  }>('/search', body);

  if (!res?.results) return [];

  return res.results.map((r) => ({
    content: r.content,
    nodeId: r.node_id,
    // Strip the "agent-" prefix to recover the agent name
    agent: r.collection?.replace(/^agent-/, '') ?? 'unknown',
  }));
}

/** Store task completion as a structured memory. Called by BaseAgent after task completes. */
export async function storeTaskMemory(agent: string, task: TaskMemory): Promise<void> {
  const content = [
    `Task ${task.id}: ${task.description}`,
    `Output: ${task.output}`,
    `Cost: $${task.costUsd.toFixed(4)}`,
  ].join('\n');

  await storeMemory(agent, content, {
    nodeType: 'event',
    importance: 0.7,
    tags: ['task-completion'],
    taskId: task.id,
    projectId: task.projectId,
    metadata: { cost_usd: task.costUsd },
  });
}

/** Check if StixDB is reachable. */
export async function isStixDBAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${STIXDB_URL}/`, {
      method: 'GET',
      headers: headers(),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
