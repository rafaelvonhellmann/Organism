import * as fs from 'fs';
import * as path from 'path';
import { AgentCapability } from '../../packages/shared/src/types.js';

const MANIFEST_PATH = path.resolve(process.cwd(), 'knowledge/agent-skills/manifest.json');
const MAX_SELECTED_SKILLS = 8;

interface SkillSource {
  repo: string;
  commit: string;
  license: string;
  localRoot: string;
}

interface SkillDefinition {
  id: string;
  name: string;
  bucket: string;
  path: string;
  description: string;
  autonomousUse: string;
  triggerTerms: string[];
}

interface SkillProfile {
  skills: string[];
  autonomy: string;
}

interface SkillManifest {
  version: number;
  updatedAt: string;
  sources: Record<string, SkillSource>;
  autonomyContract: string[];
  skills: SkillDefinition[];
  defaultProfile: SkillProfile;
  agentProfiles: Record<string, SkillProfile>;
}

export interface AgentSkillRuntime {
  context: {
    source: string;
    sourceCommit: string;
    profile: string;
    autonomy: string;
    selectedSkills: Array<{
      id: string;
      name: string;
      description: string;
      autonomousUse: string;
      path: string;
    }>;
    autonomyContract: string[];
  };
  systemPrompt: string;
}

let cachedManifest: SkillManifest | null = null;

function loadManifest(): SkillManifest | null {
  if (cachedManifest) return cachedManifest;
  if (!fs.existsSync(MANIFEST_PATH)) return null;

  const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as SkillManifest;
  cachedManifest = parsed;
  return parsed;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function findTriggeredSkills(taskDescription: string, skills: SkillDefinition[]): string[] {
  const lower = taskDescription.toLowerCase();
  return skills
    .filter((skill) => skill.triggerTerms.some((term) => lower.includes(term.toLowerCase())))
    .map((skill) => skill.id);
}

function getSkillSource(manifest: SkillManifest): { sourceName: string; source: SkillSource } {
  const sourceName = Object.keys(manifest.sources)[0] ?? 'unknown';
  const source = manifest.sources[sourceName] ?? {
    repo: 'unknown',
    commit: 'unknown',
    license: 'unknown',
    localRoot: 'knowledge/agent-skills',
  };
  return { sourceName, source };
}

function formatSystemPrompt(params: {
  agentName: string;
  capability: AgentCapability;
  sourceName: string;
  source: SkillSource;
  profile: SkillProfile;
  selectedSkills: SkillDefinition[];
  autonomyContract: string[];
}): string {
  const skillLines = params.selectedSkills.map((skill) => (
    `- /${skill.name}: ${skill.description} Autonomous use: ${skill.autonomousUse} Local doc: ${skill.path}`
  ));

  return `<agent-skill-runtime>
Matt Pocock skills are installed for this Organism agent.
Source: ${params.sourceName} (${params.source.repo}) @ ${params.source.commit}; license: ${params.source.license}.

Current agent: ${params.agentName}
Capability: ${params.capability.id} - ${params.capability.description}
Autonomous function: ${params.profile.autonomy}

Autonomy contract:
${params.autonomyContract.map((rule) => `- ${rule}`).join('\n')}

Selected skills for this run:
${skillLines.join('\n')}

How to compose the skills:
- Start with self-grill for ambiguity, then zoom out to system context when the task touches unfamiliar territory.
- For implementation or fixes, use diagnose/TDD before architecture cleanup.
- For planning, use PRD/issues/triage skills to make work independently grabbable.
- Keep Rafael-facing output concise and decision-oriented.
- Do not mention this runtime block unless it is directly useful to the task.
</agent-skill-runtime>`;
}

export function buildAgentSkillRuntime(params: {
  agentName: string;
  capability: AgentCapability;
  taskDescription: string;
}): AgentSkillRuntime | null {
  const manifest = loadManifest();
  if (!manifest) return null;

  const profile = manifest.agentProfiles[params.agentName] ?? manifest.defaultProfile;
  const triggered = findTriggeredSkills(params.taskDescription, manifest.skills);
  const selectedIds = unique([
    ...manifest.defaultProfile.skills,
    ...profile.skills,
    ...triggered,
  ]).slice(0, MAX_SELECTED_SKILLS);

  const selectedSkills = selectedIds
    .map((id) => manifest.skills.find((skill) => skill.id === id))
    .filter((skill): skill is SkillDefinition => Boolean(skill));

  const { sourceName, source } = getSkillSource(manifest);
  const systemPrompt = formatSystemPrompt({
    agentName: params.agentName,
    capability: params.capability,
    sourceName,
    source,
    profile,
    selectedSkills,
    autonomyContract: manifest.autonomyContract,
  });

  return {
    context: {
      source: sourceName,
      sourceCommit: source.commit,
      profile: params.agentName,
      autonomy: profile.autonomy,
      selectedSkills: selectedSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        autonomousUse: skill.autonomousUse,
        path: skill.path,
      })),
      autonomyContract: manifest.autonomyContract,
    },
    systemPrompt,
  };
}
