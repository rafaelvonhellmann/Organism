/**
 * Tests for innovation radar feedback parsing and structured review reasons.
 *
 * Run with:
 *   npx tsx packages/dashboard-v2/src/lib/innovation-radar-feedback.test.ts
 */

import { strict as assert } from 'node:assert';
import {
  buildInnovationRadarFeedbackRows,
  composeInnovationRadarReason,
} from './innovation-radar-feedback';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (err: unknown) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL  ${name}: ${msg}`);
    }
  })();
}

async function run() {
  console.log('\n=== Innovation Radar Feedback Tests ===\n');

  const radarOutput = {
    text: `## Innovation Radar Brief

**Project:** synapse
**Focus:** voice assessment
**Decision:** APPROVED

### Opportunity 1: Realtime oral exam rehearsal
- What changed: provider release

### Opportunity 2: Speech rubric drift detection
- What changed: benchmark paper`,
  };

  await test('structured reason preserves explicit code and note across all opportunities', async () => {
    const rows = buildInnovationRadarFeedbackRows({
      decision: 'rejected',
      reason: composeInnovationRadarReason('REJECTED_NOT_NOW', 'Revisit after pilot demand is validated.'),
      output: radarOutput,
    });

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.feedbackCode, 'REJECTED_NOT_NOW');
    assert.equal(rows[0]?.notes, 'Revisit after pilot demand is validated.');
    assert.equal(rows[0]?.trigger, 'Revisit after pilot demand is validated.');
    assert.equal(rows[1]?.opportunityTitle, 'Speech rubric drift detection');
  });

  await test('heuristic maps weak-evidence feedback when no structured code is present', async () => {
    const rows = buildInnovationRadarFeedbackRows({
      decision: 'rejected',
      reason: 'Needs stronger primary sources and less hand-wavy evidence.',
      output: radarOutput,
    });

    assert.equal(rows[0]?.feedbackCode, 'REJECTED_WEAK_EVIDENCE');
  });

  await test('heuristic maps cost objections when no structured code is present', async () => {
    const rows = buildInnovationRadarFeedbackRows({
      decision: 'rejected',
      reason: 'Interesting, but too much effort and complexity for the upside right now.',
      output: radarOutput,
    });

    assert.equal(rows[0]?.feedbackCode, 'REJECTED_TOO_COSTLY');
  });

  await test('falls back to a single null-title row when no opportunities are present', async () => {
    const rows = buildInnovationRadarFeedbackRows({
      decision: 'approved',
      reason: null,
      output: { text: '## Innovation Radar Brief\n\n**Decision:** NO_ACTION' },
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.opportunityTitle, null);
    assert.equal(rows[0]?.feedbackCode, 'APPROVED');
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
