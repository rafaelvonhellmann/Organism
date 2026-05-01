import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractShadowQualityScore } from './shadow-quality.js';

describe('shadow quality score extraction', () => {
  it('normalizes direct numeric review scores', () => {
    assert.equal(extractShadowQualityScore({ score: 8 }), 0.8);
    assert.equal(extractShadowQualityScore({ qualityScore: 0.92 }), 0.92);
    assert.equal(extractShadowQualityScore({ healthScore: 81 }), 0.81);
  });

  it('extracts normalized scores from review text', () => {
    assert.equal(
      extractShadowQualityScore('## Quality Review\n\n**Score:** 7/10'),
      0.7,
    );
    assert.equal(
      extractShadowQualityScore('## Quality Guardian Report\n\n### Platform Health Score: 74'),
      0.74,
    );
  });
});
