import * as fs from 'fs';
import * as path from 'path';
import { AgentCapability, RiskLane } from '../../shared/src/types.js';

const REGISTRY_PATH = path.resolve(process.cwd(), 'knowledge/capability-registry.json');

interface RegistryFile {
  capabilities: AgentCapability[];
}

let _registry: AgentCapability[] | null = null;

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
  const allActive = loadRegistry().filter((c) => c.status === 'active');

  // Filter to agents that can handle this project:
  // - projectScope === 'all' or undefined (generalist)
  // - projectScope is an array containing projectId
  const registry = projectId
    ? allActive.filter((c) => {
        if (!c.projectScope || c.projectScope === 'all') return true;
        return Array.isArray(c.projectScope) && c.projectScope.includes(projectId);
      })
    : allActive;

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
  return loadRegistry().filter((c) => {
    if (!c.projectScope || c.projectScope === 'all') return true;
    return Array.isArray(c.projectScope) && c.projectScope.includes(projectId);
  });
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

// Update agent status in the registry file (used by shadow-promote.ts)
export function updateAgentStatus(agentName: string, status: AgentCapability['status']): void {
  const file = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as RegistryFile;
  const cap = file.capabilities.find((c) => c.owner === agentName);
  if (!cap) throw new Error(`Agent '${agentName}' not found in registry`);
  cap.status = status;
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(file, null, 2) + '\n');
  reloadRegistry();
}
