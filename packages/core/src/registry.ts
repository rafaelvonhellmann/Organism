import * as fs from 'fs';
import * as path from 'path';
import { AgentCapability, RiskLane } from '../../shared/src/types.js';
import { getDb } from './task-queue.js';

const REGISTRY_PATH = path.resolve(process.cwd(), 'knowledge/capability-registry.json');
const PROJECTS_DIR = path.resolve(process.cwd(), 'knowledge', 'projects');
const DEFAULT_CORE_AGENTS = ['ceo', 'product-manager', 'engineering', 'devops', 'quality-agent', 'security-audit', 'legal', 'quality-guardian', 'codex-review'];

interface RegistryFile {
  capabilities: AgentCapability[];
}

interface ProjectAgentRoster {
  generalist: string[];
  specialist: string[];
}

let _registry: AgentCapability[] | null = null;

function loadProjectRoster(projectId: string): ProjectAgentRoster | null {
  const configPath = path.join(PROJECTS_DIR, projectId, 'config.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      agents?: { generalist?: string[]; specialist?: string[] };
    };
    return {
      generalist: Array.isArray(raw.agents?.generalist) ? raw.agents.generalist.filter((item): item is string => typeof item === 'string') : [],
      specialist: Array.isArray(raw.agents?.specialist) ? raw.agents.specialist.filter((item): item is string => typeof item === 'string') : [],
    };
  } catch {
    return null;
  }
}

function isEnabledForProject(capability: AgentCapability, projectId?: string): boolean {
  if (!projectId) return capability.status === 'active';

  const roster = loadProjectRoster(projectId);
  if (roster) {
    const allowedOwners = new Set([...roster.generalist, ...roster.specialist]);
    if (allowedOwners.size > 0) {
      return capability.status === 'active' && allowedOwners.has(capability.owner);
    }
  }

  if (!capability.projectScope || capability.projectScope === 'all') {
    return capability.status === 'active';
  }

  return capability.status === 'active'
    && Array.isArray(capability.projectScope)
    && capability.projectScope.includes(projectId);
}

export function loadRegistry(): AgentCapability[] {
  if (_registry) return _registry;
  if (!fs.existsSync(REGISTRY_PATH)) {
    throw new Error(`Capability registry not found at ${REGISTRY_PATH}. Run bootstrap first.`);
  }
  const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as RegistryFile;
  _registry = data.capabilities;
  return _registry;
}

// Invalidate cache (e.g., after shadow-promote.ts updates the file)
export function reloadRegistry(): void {
  _registry = null;
  loadRegistry();
}

// Resolve a task description to its owning agent.
// projectId narrows results to agents scoped for that project (plus all generalist agents).
// Returns the owner if unambiguous; returns null if multiple match (CEO will disambiguate).
export function resolveOwner(taskDescription: string, projectId?: string): AgentCapability | null {
  const registry = loadRegistry().filter((c) => isEnabledForProject(c, projectId));

  const lower = taskDescription.toLowerCase();

  const matches = registry.filter((cap) =>
    lower.includes(cap.id.replace(/\./g, ' ')) ||
    lower.includes(cap.owner) ||
    cap.description.toLowerCase().split(' ').some((w) => w.length > 4 && lower.includes(w))
  );

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return null; // Unknown — CEO will handle
  return null; // Ambiguous — CEO will disambiguate
}

// Return all agents that can work on a given project
export function getAgentsForProject(projectId: string): AgentCapability[] {
  return loadRegistry().filter((c) => isEnabledForProject(c, projectId));
}

export function getCapability(id: string): AgentCapability | undefined {
  return loadRegistry().find((c) => c.id === id);
}

export function getActiveAgents(): AgentCapability[] {
  return loadRegistry().filter((c) => c.status === 'active');
}

export function getShadowAgents(): AgentCapability[] {
  return loadRegistry().filter((c) => c.status === 'shadow');
}

export function getLaneForCapability(capabilityId: string): RiskLane {
  const cap = getCapability(capabilityId);
  return cap?.reviewerLane ?? 'MEDIUM';
}

export function getShadowRunCount(agentName: string): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) as count
    FROM shadow_runs
    WHERE agent = ?
  `).get(agentName) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function canAgentExecute(agentName: string, projectId?: string): boolean {
  return loadRegistry().some((capability) => capability.owner === agentName && isEnabledForProject(capability, projectId));
}

export function getProjectCoreAgents(projectId: string): string[] {
  const roster = loadProjectRoster(projectId);
  if (roster?.generalist.length) return roster.generalist;
  return DEFAULT_CORE_AGENTS;
}

// Update agent status in the registry file (used by shadow-promote.ts)
export function updateAgentStatus(agentName: string, status: AgentCapability['status']): void {
  const file = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as RegistryFile;
  const cap = file.capabilities.find((c) => c.owner === agentName);
  if (!cap) throw new Error(`Agent '${agentName}' not found in registry`);
  if (status === 'active') {
    const manualOverride = (cap as AgentCapability & { manualActivation?: unknown }).manualActivation;
    if (!manualOverride && getShadowRunCount(agentName) < 10) {
      throw new Error(`Agent '${agentName}' needs at least 10 shadow runs before promotion to active`);
    }
  }
  cap.status = status;
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(file, null, 2) + '\n');
  reloadRegistry();
}
