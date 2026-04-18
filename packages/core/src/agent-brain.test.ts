import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

import {
  appendPortableLearning,
  buildPortableWorkspaceSnapshot,
  ensurePortableAgentStack,
  loadPortableAgentContext,
  stagePortableReviewCandidate,
  updatePortableWorkspace,
} from './agent-brain.js';

const originalCwd = process.cwd();
let tempDir = '';

describe('agent-brain', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'organism-agent-brain-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates the portable agent stack and exposes review queue status', () => {
    ensurePortableAgentStack();

    stagePortableReviewCandidate({
      agent: 'engineering',
      projectId: 'synapse',
      taskId: 'task-123',
      kind: 'failure-pattern',
      summary: 'CI verification failed twice',
      evidence: 'Build failed after two retries on the same path.',
    });

    updatePortableWorkspace(
      buildPortableWorkspaceSnapshot(
        {
          id: 'task-123',
          agent: 'engineering',
          status: 'in_progress',
          lane: 'MEDIUM',
          description: 'Repair the CI pipeline',
          input: {},
          inputHash: 'hash',
          projectId: 'synapse',
          workflowKind: 'implement',
        },
        'engineering',
        'running',
        'Continue the bounded CI repair and re-run verification.',
      ),
    );

    appendPortableLearning({
      ts: Date.now(),
      agent: 'engineering',
      projectId: 'synapse',
      taskId: 'task-123',
      workflowKind: 'implement',
      lane: 'MEDIUM',
      status: 'success',
      summary: 'Prepared a bounded CI repair plan.',
    });

    const context = loadPortableAgentContext();

    assert.equal(context.reviewQueueStatus.pendingCount, 1);
    assert.match(context.reviewQueue, /CI verification failed twice/);
    assert.match(context.workspace, /engineering — running — synapse — implement/);
    assert.ok(fs.existsSync(path.join(tempDir, '.agent', 'memory', 'episodic', 'AGENT_LEARNINGS.jsonl')));
  });
});
