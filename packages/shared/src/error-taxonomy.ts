// Canonical error taxonomy for Organism.
// All errors MUST use these codes — Agent Lightning (Week 9) uses them as reward signal labels.
// Inconsistent codes = inconsistent RL signal.

export enum OrganismError {
  // E0xx — Orchestration
  TASK_CHECKOUT_CONFLICT = 'E001',        // Two agents tried to check out the same task
  BUDGET_CAP_EXCEEDED = 'E002',           // Agent hit its daily hard budget ceiling
  GATE_BLOCKED = 'E003',                  // G1-G4 gate rejected the output
  DOOM_LOOP_DETECTED = 'E004',            // PraisonAI detected infinite retry sequence
  MCP_CONTRACT_VIOLATION = 'E005',        // PraisonAI attempted to orchestrate or mutate tasks

  // E1xx — Quality
  LOW_CONFIDENCE_FINDING = 'E101',        // Guardian found something but couldn't verify in 2+ ways
  QUALITY_SCORE_BELOW_THRESHOLD = 'E102', // Output scored below the lane's minimum threshold
  BROWSER_VERIFICATION_FAILED = 'E103',   // Playwright spec failed or timed out
  AUTO_FIX_REGRESSION = 'E104',           // Guardian's auto-fix made the health score worse

  // E2xx — Infrastructure
  MCP_SIDECAR_UNREACHABLE = 'E201',       // PraisonAI MCP server did not respond
  SECRET_MISSING = 'E202',               // A declared required secret is not present
  SECRET_EXPIRED = 'E203',               // A secret is older than 90 days
  STATE_DB_LOCKED = 'E204',              // SQLite tasks.db is locked by another process

  // E0xx — Shape Up (bet-based execution)
  BET_NOT_FOUND = 'E006',               // Referenced bet does not exist
  BET_NOT_ACTIVE = 'E007',              // Bet is not in active/approved status
  BET_CIRCUIT_BREAKER = 'E008',         // Bet exceeded its budget/token/scope boundaries
  BET_BOUNDARY_VIOLATION = 'E009',      // Task hit a no-go or rabbit-hole boundary
  SHAPING_REQUIRED = 'E010',            // MEDIUM/HIGH task submitted without approved bet

  // E2xx — Integrations (continued)
  AGENTATION_UNREACHABLE = 'E210',      // Agentation sidecar server did not respond
  AGENTATION_SYNC_FAILED = 'E211',      // Annotation sync/import failed

  // E3xx — Agent lifecycle
  AGENT_TIMEOUT = 'E301',               // Agent session exceeded its maximum run time
  SUBAGENT_SPAWN_FAILED = 'E302',        // Guardian couldn't spawn one of its 6 parallel subagents
  SHADOW_PROMOTION_BELOW_THRESHOLD = 'E303', // Agent didn't meet the quality bar after 10 shadow runs
  DEAD_LETTER_TIMEOUT = 'E304',          // Task was in_progress for >30 min with no heartbeat
  PROVIDER_EMPTY_OUTPUT = 'E305',        // Agent returned empty output with $0 cost — silent failure
}

export interface OrganismErrorRecord {
  code: OrganismError;
  taskId: string;
  agent: string;
  message: string;
  context: unknown;
  recoveryAction: string;
  ts: number;
}

export function isOrganismError(code: string): code is OrganismError {
  return Object.values(OrganismError).includes(code as OrganismError);
}
