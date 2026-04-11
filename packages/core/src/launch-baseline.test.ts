import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { captureProjectLaunchBaseline } from './launch-baseline.js';

describe('launch-baseline', () => {
  it('writes a baseline snapshot for a launchable project', () => {
    const result = captureProjectLaunchBaseline({
      projectId: 'tokens-for-good',
      action: 'command',
      command: 'review project',
    });

    assert.equal(result.snapshot.projectId, 'tokens-for-good');
    assert.ok(result.filePath.endsWith('.json'));
    assert.equal(fs.existsSync(result.filePath), true);
    assert.equal(result.snapshot.readiness.projectId, 'tokens-for-good');
  });
});
