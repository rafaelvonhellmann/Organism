export type RiskLane = 'LOW' | 'MEDIUM' | 'HIGH';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'paused'
  | 'retry_scheduled'
  | 'completed'
  | 'failed'
  | 'dead_letter'
  | 'rolled_back'
  | 'awaiting_review';

export type AgentStatus = 'shadow' | 'active' | 'suspended';

export type GateId = 'G1' | 'G2' | 'G3' | 'G4';

export type GateDecision = 'approved' | 'rejected' | 'pending';

export type ProjectPhase = 'BUILD' | 'OPERATE' | 'GROW';
export type AutonomyMode = 'stabilization' | 'operational' | 'full_autonomy';
export type SelfAuditCadence = 'daily' | 'weekly';
export type GoalSourceKind = 'user' | 'scheduler' | 'git_watcher' | 'agent_followup' | 'dashboard' | 'system' | 'monitor';
export type WorkflowKind = 'review' | 'plan' | 'implement' | 'validate' | 'ship' | 'monitor' | 'recover' | 'shaping';
export type RetryClass =
  | 'none'
  | 'provider_overload'
  | 'rate_limit'
  | 'missing_secret'
  | 'budget_pause'
  | 'manual_pause'
  | 'transient_error'
  | 'tool_failure'
  | 'auth_failure'
  | 'policy_block';
export type ProviderFailureKind =
  | 'none'
  | 'rate_limit'
  | 'overload'
  | 'timeout'
  | 'missing_secret'
  | 'transport_error'
  | 'tool_failure'
  | 'auth_failure'
  | 'policy_block';
export type GoalStatus = 'pending' | 'running' | 'paused' | 'retry_scheduled' | 'completed' | 'failed' | 'cancelled';
export type RunSessionStatus = 'pending' | 'running' | 'paused' | 'retry_scheduled' | 'completed' | 'failed' | 'cancelled';
export type RunStepStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'skipped';
export type InterruptStatus = 'pending' | 'resolved' | 'dismissed';
export type ArtifactKind = 'plan' | 'patch' | 'command_log' | 'handoff' | 'checkpoint' | 'report' | 'deployment' | 'verification';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type RuntimeEventType =
  | 'run.started'
  | 'agent.active'
  | 'handoff.requested'
  | 'tool.started'
  | 'tool.finished'
  | 'interrupt.requested'
  | 'interrupt.resolved'
  | 'run.paused'
  | 'run.resumed'
  | 'run.finished'
  | 'deployment.created';
export type ProjectAction =
  | 'edit_code'
  | 'run_tests'
  | 'build'
  | 'commit'
  | 'push'
  | 'open_pr'
  | 'deploy'
  | 'purchase'
  | 'contact'
  | 'create_account'
  | 'destructive_migration'
  | 'cross_project';
export type WorkspaceMode = 'direct' | 'clean_required' | 'isolated_worktree';
export type MiniMaxCommand = 'search' | 'speech' | 'vision';
export type AgentEnvelopeKind =
  | 'finding'
  | 'plan'
  | 'patch'
  | 'command_proposal'
  | 'verification'
  | 'handoff_request'
  | 'approval_request'
  | 'report';

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
    note?: string;
  };
  agents: {
    generalist: string[];       // agent IDs that work on all projects
    specialist: string[];       // agent IDs scoped to this project only
  };
  repoPath?: string;
  defaultBranch?: string;
  repository?: string;
  commands?: Partial<Record<'install' | 'lint' | 'test' | 'build' | 'deploy', string>>;
  deployTargets?: Array<{
    name: string;
    provider: 'vercel' | 'render' | 'other';
    project: string;
    url?: string;
  }>;
  allowedActions?: ProjectAction[];
  blockedActions?: ProjectAction[];
  approvalThresholds?: {
    majorActions?: ProjectAction[];
  };
  envRequirements?: string[];
  workspaceMode?: WorkspaceMode;
  launchGuards?: {
    minimumHealthyRunsForDeploy?: number;
    initialWorkflowLimit?: number;
    initialAllowedWorkflows?: WorkflowKind[];
  };
  autonomySurfaces?: {
    readOnlyCanary?: boolean;
    safeTaskKeywords?: string[];
    protectedTaskKeywords?: string[];
    readOnlyWorkflows?: WorkflowKind[];
    safeImplementationWorkflows?: WorkflowKind[];
    note?: string;
  };
  selfAudit?: {
    enabled?: boolean;
    cadence?: SelfAuditCadence;
    dayOfWeek?: number;
    hour?: number;
    workflows?: WorkflowKind[];
    maxFollowups?: number;
    description?: string;
  };
  innovationRadar?: {
    enabled?: boolean;
    cadence?: SelfAuditCadence;
    dayOfWeek?: number;
    hour?: number;
    agent?: string;
    shadow?: boolean;
    focusAreas?: string[];
    maxOpportunities?: number;
    description?: string;
  };
  toolProviders?: {
    minimax?: {
      enabled?: boolean;
      region?: 'global' | 'cn';
      allowedCommands?: MiniMaxCommand[];
      authMode?: 'auto' | 'api-key' | 'session';
    };
  };
  budgetCaps?: {
    dailyUsd?: number;
    deployUsd?: number;
    contactUsd?: number;
    purchaseUsd?: number;
  };
  autonomyMode?: AutonomyMode;
}

export interface Task {
  id: string;
  agent: string;
  status: TaskStatus;
  attemptCount?: number;
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
  goalId?: string;
  workflowKind?: WorkflowKind;
  sourceKind?: GoalSourceKind;
  retryClass?: RetryClass;
  retryAt?: number | null;
  providerFailureKind?: ProviderFailureKind;
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
  action: 'task_created' | 'task_checkout' | 'task_completed' | 'task_failed' | 'gate_eval' | 'budget_check' | 'mcp_call' | 'shadow_run' | 'source_injection' | 'auto_approved' | 'error' | 'runtime_event';
  payload: unknown;
  outcome: 'success' | 'failure' | 'blocked';
  errorCode?: string;
}

export interface TypedFinding {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  summary: string;
  evidence?: string;
  remediation?: string;
  actionable: boolean;
  targetCapability?: string;
  followupKind?: WorkflowKind;
}

export interface CommandProposal {
  id: string;
  action: ProjectAction;
  command: string;
  cwd?: string;
  reason: string;
  requiresApproval: boolean;
}

export interface HandoffRequest {
  id: string;
  targetAgent: string;
  workflowKind: WorkflowKind;
  reason: string;
  summary: string;
  execution?: boolean;
}

export interface ApprovalRequest {
  id: string;
  action: ProjectAction;
  reason: string;
  summary: string;
}

export interface AgentEnvelope {
  kind: AgentEnvelopeKind;
  agent: string;
  summary: string;
  text?: string;
  findings?: TypedFinding[];
  commandProposals?: CommandProposal[];
  handoffRequests?: HandoffRequest[];
  approvalRequests?: ApprovalRequest[];
  artifacts?: Array<{ kind: ArtifactKind; title: string; path?: string; content?: string }>;
  payload?: unknown;
}

export interface Goal {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: GoalStatus;
  sourceKind: GoalSourceKind;
  workflowKind: WorkflowKind;
  inputHash: string;
  createdAt: number;
  updatedAt: number;
  latestRunId?: string | null;
}

export interface RunSession {
  id: string;
  goalId: string;
  projectId: string;
  agent: string;
  workflowKind: WorkflowKind;
  status: RunSessionStatus;
  retryClass: RetryClass;
  retryAt?: number | null;
  providerFailureKind?: ProviderFailureKind;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
}

export interface RunStep {
  id: string;
  runId: string;
  name: string;
  status: RunStepStatus;
  detail?: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
}

export interface Interrupt {
  id: string;
  runId: string;
  type: 'approval' | 'info_request' | 'policy_block' | 'manual_pause';
  status: InterruptStatus;
  summary: string;
  detail?: string | null;
  createdAt: number;
  resolvedAt?: number | null;
}

export interface Artifact {
  id: string;
  runId: string;
  goalId: string;
  kind: ArtifactKind;
  title: string;
  path?: string | null;
  content?: string | null;
  createdAt: number;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  action: ProjectAction;
  status: ApprovalStatus;
  requestedBy: string;
  requestedAt: number;
  decidedAt?: number | null;
  decidedBy?: string | null;
  reason?: string | null;
}

export interface ProjectPolicy {
  projectId: string;
  repoPath: string | null;
  defaultBranch: string;
  qualityStandards: string[];
  riskOverrides: {
    keywords: string[];
    defaultLane: RiskLane | null;
    note: string | null;
  };
  commands: Partial<Record<'install' | 'lint' | 'test' | 'build' | 'deploy', string>>;
  deployTargets: Array<{
    name: string;
    provider: 'vercel' | 'render' | 'other';
    project: string;
    url?: string;
  }>;
  allowedActions: ProjectAction[];
  blockedActions: ProjectAction[];
  approvalThresholds: {
    majorActions: ProjectAction[];
  };
  envRequirements: string[];
  workspaceMode: WorkspaceMode;
  launchGuards: {
    minimumHealthyRunsForDeploy: number;
    initialWorkflowLimit: number;
    initialAllowedWorkflows: WorkflowKind[];
  };
  autonomySurfaces: {
    readOnlyCanary: boolean;
    safeTaskKeywords: string[];
    protectedTaskKeywords: string[];
    readOnlyWorkflows: WorkflowKind[];
    safeImplementationWorkflows: WorkflowKind[];
    note: string | null;
  };
  selfAudit: {
    enabled: boolean;
    cadence: SelfAuditCadence;
    dayOfWeek: number | null;
    hour: number;
    workflows: WorkflowKind[];
    maxFollowups: number;
    description: string;
  };
  innovationRadar: {
    enabled: boolean;
    cadence: SelfAuditCadence;
    dayOfWeek: number | null;
    hour: number;
    agent: string;
    shadow: boolean;
    focusAreas: string[];
    maxOpportunities: number;
    description: string;
  };
  toolProviders: {
    minimax: {
      enabled: boolean;
      region: 'global' | 'cn';
      allowedCommands: MiniMaxCommand[];
      authMode: 'auto' | 'api-key' | 'session';
    };
  };
  budgetCaps: {
    dailyUsd: number | null;
    deployUsd: number | null;
    contactUsd: number | null;
    purchaseUsd: number | null;
  };
  autonomyMode: AutonomyMode;
}

export interface AgentProfile {
  name: string;
  status: AgentStatus;
  model: AgentCapability['model'];
  frequencyTier: AgentCapability['frequencyTier'];
  core: boolean;
  readOnly: boolean;
  canDelegate: boolean;
}

export interface RuntimeEvent {
  id: number;
  runId: string;
  goalId: string;
  eventType: RuntimeEventType;
  payload: unknown;
  ts: number;
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
