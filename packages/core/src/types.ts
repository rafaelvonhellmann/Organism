// Re-export shared types + any core-specific extensions
export * from '../../shared/src/types.js';

export interface PipelineState {
  taskId: string;
  lane: import('../../shared/src/types.js').RiskLane;
  currentStage: string;
  completedStages: string[];
  remainingStages: string[];
  startedAt: number;
}

export interface HeartbeatRecord {
  taskId: string;
  agent: string;
  ts: number;
  progressNote?: string;
}
