export type RiskLane = 'LOW' | 'MEDIUM' | 'HIGH';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'dead_letter'
  | 'rolled_back'
  | 'awaiting_review';

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
  betId?: string;       // linked Shape Up bet (required for MEDIUM/HIGH tasks)
}

export interface AgentCapability {
  id: string;
  owner: string;
  collaborators: string[];
  reviewerLane: RiskLane;
  description: string;
  status: AgentStatus;
  model: 'haiku' | 'sonnet' | 'opus' | 'gpt4o' | 'gpt5.4';
  frequencyTier: 'always-on' | 'daily' | '2-3x-week' | 'weekly' | 'on-demand' | 'monthly';
  projectScope?: string[] | 'all';  // 'all' = generalist, string[] = scoped to listed project IDs
  knowledgeSources?: string[];      // paths to reference documents read at session start
}

export interface AuditEntry {
  id?: number;
  ts: number;
  agent: string;
  taskId: string;
  action: 'task_created' | 'task_checkout' | 'task_completed' | 'task_failed' | 'gate_eval' | 'budget_check' | 'mcp_call' | 'shadow_run' | 'source_injection' | 'error';
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

// ── Shape Up (Bet-Based Execution) ─────────────────────────────────────────

export type BetStatus =
  | 'pitch_draft'
  | 'pitch_ready'
  | 'bet_approved'
  | 'active'
  | 'paused'
  | 'cooldown'
  | 'done'
  | 'cancelled';

export type HillPhase = 'figuring_out' | 'making_it_happen';

export type ExceptionType =
  | 'appetite_exceeded'
  | 'token_budget_exceeded'
  | 'scope_expansion'
  | 'rabbit_hole_hit'
  | 'no_go_hit'
  | 'unauthorized_specialist'
  | 'manual_pause';

export interface Pitch {
  id: string;
  title: string;
  problem: string;
  appetite: string;           // e.g. "small batch" (1-2 days), "big batch" (up to 6 weeks)
  solution_sketch: string;
  rabbit_holes: string;       // known rabbit holes to avoid (JSON array or text)
  no_gos: string;             // things explicitly out of scope
  shaped_by: string;          // who/what shaped this pitch
  project_id: string;
  status: 'draft' | 'ready' | 'rejected';
  created_at: number;
  updated_at: number;
}

export interface Bet {
  id: string;
  pitch_id: string | null;
  title: string;
  problem: string;
  appetite: string;
  status: BetStatus;
  shaped_by: string;
  approved_by: string | null;
  token_budget: number;       // max tokens allowed for this bet
  cost_budget_usd: number;    // max USD spend for this bet
  tokens_used: number;
  cost_used_usd: number;
  no_gos: string;             // JSON array of things not to do
  rabbit_holes: string;       // JSON array of known rabbit holes
  success_criteria: string;   // JSON array or text description
  project_id: string;
  created_at: number;
  updated_at: number;
}

export interface BetScope {
  id: string;
  bet_id: string;
  title: string;
  description: string;
  hill_phase: HillPhase;
  hill_progress: number;      // 0-100, where 0-50 = figuring out, 51-100 = making it happen
  completed: boolean;
  created_at: number;
  updated_at: number;
}

export interface HillUpdate {
  id: string;
  bet_id: string;
  scope_id: string | null;
  hill_progress: number;
  note: string;
  agent: string;              // which agent posted this update
  created_at: number;
}

export interface BetDecision {
  id: string;
  bet_id: string;
  decision: 'approved' | 'rejected' | 'paused' | 'resumed' | 'cancelled' | 'completed';
  reason: string;
  decided_by: string;         // 'rafael', 'system', or agent name
  exception_type: ExceptionType | null;
  created_at: number;
}

/** Conditions that trigger specialist review agents instead of running them by default */
export interface SpecialistTrigger {
  agent: string;              // e.g. 'legal', 'security-audit', 'quality-guardian'
  conditions: string[];       // keywords, lane, or bet characteristics that justify invocation
  min_lane: RiskLane;         // minimum risk lane to even consider this specialist
  requires_bet: boolean;      // whether an active bet is required
}

// ── Perspective System (Phase 1) ──────────────────────────────────────────

export type PerspectiveStatus = 'active' | 'dormant' | 'candidate';

export interface Perspective {
  id: string;                    // e.g. "strategy", "engineering", "legal"
  domain: string;                // display name e.g. "Strategy", "Engineering"
  systemPrompt: string;          // the LLM instruction for this perspective
  relevanceKeywords: string[];   // for auto-matching tasks to perspectives
  projectFitness: Record<string, number>;  // { "synapse": 0.9, "tfg": 0.3 }
  status: PerspectiveStatus;
  model: 'haiku' | 'sonnet' | 'opus';
  totalInvocations: number;
  totalCostUsd: number;
  avgRating: number;             // 0-10 from feedback
  lastUsed: number;              // timestamp
}

export interface PerspectiveResult {
  perspectiveId: string;
  domain: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface PerspectiveReviewResult {
  projectId: string;
  scope: string;
  perspectives: PerspectiveResult[];
  totalCostUsd: number;
  totalDurationMs: number;
  timestamp: number;
}
