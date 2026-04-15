function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function tryParseTaskOutput(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildFailureSummary(projectId: string, error: string): string {
  return `Execution failed for ${projectId}: ${error}`;
}

export function reconcileTaskOutput(raw: unknown, error: unknown, projectId: unknown): unknown {
  const parsed = tryParseTaskOutput(raw);
  const currentError = asString(error);
  const project = typeof projectId === 'string' && projectId.length > 0 ? projectId : 'project';

  if (!currentError || typeof parsed !== 'object' || parsed === null) {
    return parsed;
  }

  const record = parsed as Record<string, unknown>;
  const payload = typeof record.payload === 'object' && record.payload !== null
    ? { ...(record.payload as Record<string, unknown>) }
    : null;

  const summaryCandidates = [
    record.summary,
    record.text,
    record.implementation,
    payload?.summary,
    payload?.implementation,
  ]
    .map(asString)
    .filter((value): value is string => !!value);

  const currentLower = currentError.toLowerCase();
  const payloadMode = asString(payload?.mode)?.toLowerCase() ?? '';
  const looksLikeFailure = payloadMode === 'failed'
    || summaryCandidates.some((value) => /execution failed|credit balance is too low|fetch failed|sql write operations are forbidden|timed out|timeout/i.test(value));
  const alreadyCurrent = summaryCandidates.some((value) => value.toLowerCase().includes(currentLower));

  if (!looksLikeFailure || alreadyCurrent) {
    return parsed;
  }

  const summary = buildFailureSummary(project, currentError);
  const implementation = `Execution failed: ${currentError}`;

  const next: Record<string, unknown> = {
    ...record,
    summary,
    text: summary,
    implementation,
  };

  if (payload) {
    next.payload = {
      ...payload,
      summary,
      implementation,
      currentError,
    };
  }

  return next;
}

export function summarizeTaskOutput(raw: unknown, error: unknown, projectId: unknown): string | null {
  const parsed = reconcileTaskOutput(raw, error, projectId);
  if (parsed == null) return null;
  if (typeof parsed === 'string') return parsed.slice(0, 1200);
  if (typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    const preferred = [record.summary, record.review, record.text, record.verdict, record.result]
      .map(asString)
      .find((value): value is string => !!value);
    if (preferred) return preferred.slice(0, 1200);
    return JSON.stringify(parsed, null, 2).slice(0, 1200);
  }
  return String(parsed).slice(0, 1200);
}
