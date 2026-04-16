import { AgentEnvelope, AgentEnvelopeKind, HandoffRequest, Task, TypedFinding } from '../../shared/src/types.js';

function extractText(output: unknown): string {
  if (!output) return '';
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    const keys = ['summary', 'text', 'report', 'review', 'implementation', 'analysis', 'plan', 'brief'];
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'string' && value.trim().length > 20) {
        return value.trim();
      }
    }
    return JSON.stringify(output);
  }
  return String(output);
}

function inferKind(agent: string, output: Record<string, unknown>, task: Task): AgentEnvelopeKind {
  if (Array.isArray(output.findings)) return 'finding';
  if (Array.isArray(output.commandProposals)) return 'command_proposal';
  if (Array.isArray(output.handoffRequests)) return 'handoff_request';
  if (output.kind && typeof output.kind === 'string') return output.kind as AgentEnvelopeKind;
  if (agent === 'engineering') return 'patch';
  if (agent === 'security-audit' || agent === 'legal' || agent.startsWith('quality')) return 'finding';
  if (task.description.startsWith('[SHAPING]') || agent === 'product-manager' || agent === 'cto') return 'plan';
  return 'report';
}

export function normalizeAgentEnvelope(agent: string, task: Task, output: unknown): AgentEnvelope {
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    if (
      typeof record.kind === 'string' &&
      typeof record.agent === 'string' &&
      typeof record.summary === 'string'
    ) {
      return record as unknown as AgentEnvelope;
    }

    const summary = typeof record.summary === 'string'
      ? record.summary
      : extractText(output).slice(0, 400);

    return {
      kind: inferKind(agent, record, task),
      agent,
      summary,
      text: extractText(output),
      findings: Array.isArray(record.findings) ? record.findings as TypedFinding[] : undefined,
      commandProposals: Array.isArray(record.commandProposals) ? record.commandProposals as AgentEnvelope['commandProposals'] : undefined,
      handoffRequests: Array.isArray(record.handoffRequests) ? record.handoffRequests as HandoffRequest[] : undefined,
      approvalRequests: Array.isArray(record.approvalRequests) ? record.approvalRequests as AgentEnvelope['approvalRequests'] : undefined,
      artifacts: Array.isArray(record.artifacts) ? record.artifacts as AgentEnvelope['artifacts'] : undefined,
      payload: output,
    };
  }

  const text = extractText(output);
  return {
    kind: inferKind(agent, {}, task),
    agent,
    summary: text.slice(0, 400),
    text,
    payload: output,
  };
}

export function extractEnvelopeText(output: unknown): string {
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    if (typeof record.summary === 'string' && typeof record.text === 'string') {
      return record.text as string;
    }
  }
  return extractText(output);
}

export function extractFindings(output: unknown): TypedFinding[] {
  if (!output || typeof output !== 'object') return [];
  const record = output as Record<string, unknown>;
  if (Array.isArray(record.findings)) return record.findings as TypedFinding[];
  if (record.payload && typeof record.payload === 'object') {
    const payload = record.payload as Record<string, unknown>;
    return Array.isArray(payload.findings) ? payload.findings as TypedFinding[] : [];
  }
  return [];
}

export function extractHandoffs(output: unknown): HandoffRequest[] {
  if (!output || typeof output !== 'object') return [];
  const record = output as Record<string, unknown>;
  if (Array.isArray(record.handoffRequests)) return record.handoffRequests as HandoffRequest[];
  if (record.payload && typeof record.payload === 'object') {
    const payload = record.payload as Record<string, unknown>;
    return Array.isArray(payload.handoffRequests) ? payload.handoffRequests as HandoffRequest[] : [];
  }
  return [];
}
