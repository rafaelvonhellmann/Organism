import * as fs from 'fs';
import * as path from 'path';
import { AgentCapability, RiskLane } from '../../shared/src/types.js';
import { getDb } from './task-queue.js';

const REGISTRY_PATH = path.resolve(process.cwd(), 'knowledge/capability-registry.json');
const PROJECTS_DIR = path.resolve(process.cwd(), 'knowledge', 'projects');
const DEFAULT_CORE_AGENTS = ['ceo', 'product-manager', 'engineering', 'devops', 'quality-agent', 'security-audit', 'legal', 'quality-guardian', 'codex-review'];
const AGENT_OWNER_ALIASES: Record<string, string> = {
  'grill-me': 'domain-model',
};

interface RegistryFile {
  capabilities: AgentCapability[];
}

interface ProjectAgentRoster {
  generalist: string[];
  specialist: string[];
}

interface CapabilityFilterOptions {
  includeShadow?: boolean;
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

function isCapabilityStatusEnabled(capability: AgentCapability, options?: CapabilityFilterOptions): boolean {
  return capability.status === 'active' || (options?.includeShadow === true && capability.status === 'shadow');
}

function isEnabledForProject(capability: AgentCapability, projectId?: string, options?: CapabilityFilterOptions): boolean {
  if (!projectId) return isCapabilityStatusEnabled(capability, options);

  const roster = loadProjectRoster(projectId);
  if (roster) {
    const allowedOwners = new Set([...roster.generalist, ...roster.specialist]);
    if (allowedOwners.size > 0) {
      return isCapabilityStatusEnabled(capability, options) && allowedOwners.has(capability.owner);
    }
  }

  if (!capability.projectScope || capability.projectScope === 'all') {
    return isCapabilityStatusEnabled(capability, options);
  }

  return isCapabilityStatusEnabled(capability, options)
    && Array.isArray(capability.projectScope)
    && capability.projectScope.includes(projectId);
}

export function getCapabilitiesForProject(projectId?: string, options?: CapabilityFilterOptions): AgentCapability[] {
  return loadRegistry().filter((capability) => isEnabledForProject(capability, projectId, options));
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
  const registry = getCapabilitiesForProject(projectId);

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
  return getCapabilitiesForProject(projectId);
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

export function canAgentExecute(agentName: string, projectId?: string, options?: CapabilityFilterOptions): boolean {
  const normalizedAgentName = AGENT_OWNER_ALIASES[agentName] ?? agentName;
  return getCapabilitiesForProject(projectId, options)
    .some((capability) => capability.owner === agentName || capability.owner === normalizedAgentName);
}

export function getProjectCoreAgents(projectId: string): string[] {
  const roster = loadProjectRoster(projectId);
  if (roster?.generalist.length) return roster.generalist;
  return DEFAULT_CORE_AGENTS;
}

// Structural coherence check between registry and the in-process AGENT_MAP.
// Run at daemon startup to fail fast if registry/runtime drift.
// Missing implementations = warn (task will fail at dispatch with cryptic error).
// Implementations without registry entry = warn (budget cap / routing / status will silently mismatch).
export interface RegistryCoherenceReport {
  missingImplementations: string[];
  orphanedImplementations: string[];
  activeCount: number;
  shadowCount: number;
  suspendedCount: number;
}

export function checkRegistryCoherence(registeredRunnerAgents: string[]): RegistryCoherenceReport {
  const caps = loadRegistry();
  const registryOwners = new Set<string>();
  const activeOrShadow = caps.filter((c) => c.status === 'active' || c.status === 'shadow');
  for (const cap of activeOrShadow) registryOwners.add(cap.owner);

  const runnerSet = new Set(registeredRunnerAgents);
  const missingImplementations: string[] = [];
  for (const owner of registryOwners) {
    const aliased = AGENT_OWNER_ALIASES[owner] ?? owner;
    if (!runnerSet.has(owner) && !runnerSet.has(aliased)) {
      missingImplementations.push(owner);
    }
  }

  const orphanedImplementations: string[] = [];
  for (const runnerAgent of runnerSet) {
    const matched = caps.some((c) => c.owner === runnerAgent || AGENT_OWNER_ALIASES[c.owner] === runnerAgent);
    if (!matched) orphanedImplementations.push(runnerAgent);
  }

  return {
    missingImplementations,
    orphanedImplementations,
    activeCount: caps.filter((c) => c.status === 'active').length,
    shadowCount: caps.filter((c) => c.status === 'shadow').length,
    suspendedCount: caps.filter((c) => c.status === 'suspended').length,
  };
}

// Update agent status in the registry file (used by shadow-promote.ts)
export function updateAgentStatus(agentName: string, status: AgentCapability['status']): void {
  const file = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as RegistryFile;
  const normalizedAgentName = AGENT_OWNER_ALIASES[agentName] ?? agentName;
  const cap = file.capabilities.find((c) => c.owner === agentName || c.owner === normalizedAgentName);
  if (!cap) throw new Error(`Agent '${agentName}' not found in registry`);
  if (status === 'active') {
    const manualOverride = (cap as AgentCapability & { manualActivation?: unknown }).manualActivation;
    if (!manualOverride && getShadowRunCount(normalizedAgentName) < 10) {
      throw new Error(`Agent '${agentName}' needs at least 10 shadow runs before promotion to active`);
    }
  }
  cap.status = status;
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(file, null, 2) + '\n');
  reloadRegistry();
}
