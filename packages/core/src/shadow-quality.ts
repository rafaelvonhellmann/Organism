function normalizeScore(value: number, denominator: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const normalized = value / denominator;
  if (!Number.isFinite(normalized)) return null;
  return Math.max(0, Math.min(1, normalized));
}

function normalizeDetectedScore(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value <= 1) return Math.max(0, value);
  if (value <= 10) return normalizeScore(value, 10);
  if (value <= 100) return normalizeScore(value, 100);
  return null;
}

function extractNumericScore(record: Record<string, unknown>): number | null {
  for (const key of ['qualityScore', 'score', 'healthScore']) {
    const value = record[key];
    if (typeof value === 'number') {
      return normalizeDetectedScore(value);
    }
  }

  for (const value of Object.values(record)) {
    if (typeof value === 'string') {
      const tenPoint = value.match(/score[^0-9]*(\d+(?:\.\d+)?)\s*\/\s*10/i);
      if (tenPoint) {
        return normalizeScore(Number.parseFloat(tenPoint[1]!), 10);
      }

      const hundredPoint = value.match(/health score[^0-9]*(\d+(?:\.\d+)?)\s*\/\s*100/i)
        ?? value.match(/platform health score[^0-9]*(\d+(?:\.\d+)?)/i);
      if (hundredPoint) {
        return normalizeScore(Number.parseFloat(hundredPoint[1]!), 100);
      }
    }
  }

  return null;
}

export function extractShadowQualityScore(output: unknown): number | null {
  if (!output) return null;
  if (typeof output === 'number') return normalizeDetectedScore(output);
  if (typeof output === 'string') {
    return extractNumericScore({ scoreText: output });
  }
  if (typeof output !== 'object') return null;

  const direct = extractNumericScore(output as Record<string, unknown>);
  if (direct !== null) return direct;

  const record = output as Record<string, unknown>;
  for (const nestedKey of ['payload', 'review', 'report']) {
    const nested = record[nestedKey];
    const nestedScore = extractShadowQualityScore(nested);
    if (nestedScore !== null) return nestedScore;
  }

  return null;
}
