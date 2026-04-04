export type RiskLane = 'LOW' | 'MEDIUM' | 'HIGH';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'dead_letter'
  | 'rolled_back';

export type AgentStatus = 'shadow' | 'active' | 'suspended';

export type GateId = 'G1' | 'G2' | 'G3' | 'G4';

export type GateDecision = 'approved' | 'rejected' | 'pending';

export type ProjectPhase = 'BUILD' | 'OPERATE' | 'GROW';

export interface ProjectConfig {
  id: string;
  name: string;
  phase: ProjectPhase;
  description: string;
  techStack: string[];
  qualityStandards: string[];   // e.g. ['MEDICAL'] triggers auto-HIGH for grading content
  riskOverrides: {
    keywords?: string[];        // keywords that force HIGH lane regardless of classifier
    defaultLane?: RiskLane;     // override default LOW classification for all tasks
  };
  agents: {
    generalist: string[];       // agent IDs that work on all projects
    specialist: string[];       // agent IDs scoped to this project only
  };
}

export interface Task {
  id: string;
  agent: string;
  status: TaskStatus;
  lane: RiskLane;
  description: string;
  input: unknown;
  inputHash: string;
  output?: unknown;
  tokensUsed?: number;
  costUsd?: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  parentTaskId?: string; // goal ancestry chain
  projectId?: string;   // which project this task belongs to (default: 'organism')
}

export interface AgentCapability {
  id: string;
  owner: string;
  collaborators: string[];
  reviewerLane: RiskLane;
  description: string;
  status: AgentStatus;
  model: 'haiku' | 'sonnet' | 'opus' | 'gpt4o';
  frequencyTier: 'always-on' | 'daily' | '2-3x-week' | 'weekly' | 'on-demand' | 'monthly';
  projectScope?: string[] | 'all';  // 'all' = generalist, string[] = scoped to listed project IDs
  knowledgeSources?: string[];      // paths to reference documents read at session start
}

export interface AuditEntry {
  id?: number;
  ts: number;
  agent: string;
  taskId: string;
  action: 'task_created' | 'task_checkout' | 'task_completed' | 'task_failed' | 'gate_eval' | 'budget_check' | 'mcp_call' | 'shadow_run' | 'error';
  payload: unknown;
  outcome: 'success' | 'failure' | 'blocked';
  errorCode?: string;
}

export interface AgentSpend {
  agent: string;
  date: string; // YYYY-MM-DD
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface RiskClassification {
  lane: RiskLane;
  reason: string;
  factors: string[];
  method: 'smell-test' | 'classifier'; // smell-test = free regex, classifier = Haiku call
}

export interface GateRecord {
  id: string;
  taskId: string;
  gate: GateId;
  decision: GateDecision;
  decidedBy: 'auto' | 'rafael';
  reason?: string;
  decidedAt?: number;
  patchPath?: string; // for Guardian auto-fix patches
}

export interface GuardianReport {
  date: string;
  healthScore: number;
  issues: GuardianIssue[];
  autoFixed: GuardianFix[];
  needsApproval: GuardianProposal[];
  featureSuggestions: FeatureSuggestion[];
  metrics: {
    pagesAudited: number;
    issuesBySeverity: { critical: number; high: number; medium: number };
    autoFixedCount: number;
    confidenceFilter: 'HIGH_AND_MEDIUM_ONLY';
  };
}

export interface GuardianIssue {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  area: string;
  issue: string;
  evidence: string;
  confidence: 'HIGH' | 'MEDIUM';
  bestFix: string;
  fingerprint: string; // stable hash for trend tracking
  consecutiveRuns?: number;
}

export interface GuardianFix {
  issue: string;
  whatWasDone: string;
  verified: boolean;
  patchPath?: string;
}

export interface GuardianProposal {
  issue: string;
  proposedFix: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  effort: 'S' | 'M' | 'L';
  patchPath: string;
  stagedAt: number;
  autoApplyAfter?: number; // unix ts — null means manual approval required
}

export interface FeatureSuggestion {
  name: string;
  problem: string;
  evidence: string;
  effort: 'S' | 'M' | 'L';
  impact: 'LOW' | 'MEDIUM' | 'HIGH';
  proposal: string;
}
