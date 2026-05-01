import * as fs from 'fs';
import * as path from 'path';
import { OrganismError } from '../../packages/shared/src/error-taxonomy.js';
import { AgentCapability } from '../../packages/shared/src/types.js';

const MATRIX_PATH = path.resolve(process.cwd(), 'knowledge/operating-model/verifiability-matrix.json');

type VerifiabilityClass = 'HIGH' | 'MEDIUM' | 'LOW' | 'NON_DELEGABLE';

interface VerifiabilityClassDefinition {
  description: string;
  runtimePosture: string;
}

interface VerifiabilityProfile {
  verifiability: VerifiabilityClass;
  onRailsSignals?: string[];
  offRoadSignals?: string[];
  mustVerify: string[];
  approvalRequiredFor: string[];
}

interface VerifiabilityMatrix {
  version: number;
  updatedAt: string;
  source: string;
  classes: Record<VerifiabilityClass, VerifiabilityClassDefinition>;
  defaultProfile: VerifiabilityProfile;
  agentProfiles: Record<string, Partial<VerifiabilityProfile> & { verifiability: VerifiabilityClass }>;
}

export interface VerifiabilityRuntime {
  context: {
    class: VerifiabilityClass;
    classDescription: string;
    runtimePosture: string;
    mustVerify: string[];
    approvalRequiredFor: string[];
    onRailsSignals: string[];
    offRoadSignals: string[];
  };
  systemPrompt: string;
}

let cachedMatrix: VerifiabilityMatrix | null = null;

function loadMatrix(): VerifiabilityMatrix | null {
  if (cachedMatrix) return cachedMatrix;
  if (!fs.existsSync(MATRIX_PATH)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8')) as VerifiabilityMatrix;
    cachedMatrix = parsed;
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${OrganismError.VERIFIABILITY_MATRIX_INVALID}: Failed to load verifiability matrix: ${message}`);
  }
}

function mergeProfile(
  defaultProfile: VerifiabilityProfile,
  agentProfile: (Partial<VerifiabilityProfile> & { verifiability: VerifiabilityClass }) | undefined,
): VerifiabilityProfile {
  if (!agentProfile) return defaultProfile;

  return {
    verifiability: agentProfile.verifiability,
    onRailsSignals: agentProfile.onRailsSignals ?? defaultProfile.onRailsSignals ?? [],
    offRoadSignals: agentProfile.offRoadSignals ?? defaultProfile.offRoadSignals ?? [],
    mustVerify: [...new Set([...(defaultProfile.mustVerify ?? []), ...(agentProfile.mustVerify ?? [])])],
    approvalRequiredFor: [
      ...new Set([...(defaultProfile.approvalRequiredFor ?? []), ...(agentProfile.approvalRequiredFor ?? [])]),
    ],
  };
}

function formatSystemPrompt(params: {
  agentName: string;
  capability: AgentCapability;
  profile: VerifiabilityProfile;
  classDefinition: VerifiabilityClassDefinition;
}): string {
  return `<verifiability-runtime>
Current agent: ${params.agentName}
Capability: ${params.capability.id} - ${params.capability.description}
Verifiability class: ${params.profile.verifiability}
Class meaning: ${params.classDefinition.description}
Runtime posture: ${params.classDefinition.runtimePosture}

Required verification behavior:
${params.profile.mustVerify.map((item) => `- ${item}`).join('\n')}

Approval required for:
${params.profile.approvalRequiredFor.map((item) => `- ${item}`).join('\n')}

On-rails signals:
${(params.profile.onRailsSignals ?? []).map((item) => `- ${item}`).join('\n')}

Off-road signals:
${(params.profile.offRoadSignals ?? []).map((item) => `- ${item}`).join('\n')}

When off-road, slow down: cite evidence, mark uncertainty, propose actions instead of applying them, and ask Rafael/professionals for non-delegable decisions.
</verifiability-runtime>`;
}

export function buildVerifiabilityRuntime(params: {
  agentName: string;
  capability: AgentCapability;
}): VerifiabilityRuntime | null {
  const matrix = loadMatrix();
  if (!matrix) return null;

  const profile = mergeProfile(matrix.defaultProfile, matrix.agentProfiles[params.agentName]);
  const classDefinition = matrix.classes[profile.verifiability];
  if (!classDefinition) {
    throw new Error(
      `${OrganismError.VERIFIABILITY_MATRIX_INVALID}: Unknown verifiability class ${profile.verifiability}`,
    );
  }

  return {
    context: {
      class: profile.verifiability,
      classDescription: classDefinition.description,
      runtimePosture: classDefinition.runtimePosture,
      mustVerify: profile.mustVerify,
      approvalRequiredFor: profile.approvalRequiredFor,
      onRailsSignals: profile.onRailsSignals ?? [],
      offRoadSignals: profile.offRoadSignals ?? [],
    },
    systemPrompt: formatSystemPrompt({
      agentName: params.agentName,
      capability: params.capability,
      profile,
      classDefinition,
    }),
  };
}
