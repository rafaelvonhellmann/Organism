/**
 * Model + sidecar client for Organism agents.
 *
 * Organism keeps its model discipline (Haiku/Sonnet/Opus), but runtime model
 * access now passes through the PraisonAI sidecar contract first. The current
 * default transport is an embedded implementation that preserves the codex-first
 * backend policy while keeping the boundary explicit and testable. An external
 * Python sidecar transport is available for parity work and stricter isolation.
 */

import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { getSecretOrNull } from '../../packages/shared/src/secrets.js';
import { STATE_DIR } from '../../packages/shared/src/state-dir.js';
import { OrganismError } from '../../packages/shared/src/error-taxonomy.js';

type LogicalModelProfile = 'haiku' | 'sonnet' | 'opus';
export type SupportedModelProfile = LogicalModelProfile | 'gpt4o' | 'gpt5.4';
export type SidecarToolName = 'route_model' | 'rag_retrieve' | 'check_policy' | 'detect_doom_loop' | 'persist_memory';
export type SidecarPreference = 'auto' | 'embedded' | 'external' | 'disabled';
export type ResolvedSidecarMode = 'embedded' | 'external' | 'disabled';

export const SIDECAR_TOOL_NAMES: SidecarToolName[] = [
  'route_model',
  'rag_retrieve',
  'check_policy',
  'detect_doom_loop',
  'persist_memory',
];

const MODEL_ALIASES: Record<LogicalModelProfile, string> = {
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
};

export type ModelBackendKind = 'claude-cli' | 'anthropic-api' | 'codex-cli' | 'openai-api';
export type ModelBackendPreference = ModelBackendKind | 'auto' | 'codex-first';

interface ModelBackendAvailability {
  claudeCli: boolean;
  anthropicApi: boolean;
  codexCli: boolean;
  openaiApi: boolean;
}

interface ModelBackendCapabilities {
  webSearch: boolean;
  cliRateLimits: boolean;
}

export interface ModelBackendStatus {
  preferred: ModelBackendPreference;
  selected: ModelBackendKind;
  available: ModelBackendAvailability;
  capabilities: ModelBackendCapabilities;
}

export interface SidecarStatus {
  preferred: SidecarPreference;
  selected: ResolvedSidecarMode;
  tools: SidecarToolName[];
  externalAvailable: boolean;
  scriptPath: string;
}

interface OpenAiModelSpec {
  cliModel: string;
  apiModel: string;
  reasoningEffort: 'low' | 'medium' | 'high';
}

type BackendFailureClass = 'rate_limit' | 'credit' | 'transport' | 'auth' | 'generic';

const BACKEND_HEALTH_PATH = join(homedir(), '.organism', 'state', 'model-backend-health.json');
const SIDECAR_SERVER_PATH = join(process.cwd(), 'packages', 'mcp-sidecar', 'server.py');
const SIDECAR_MEMORY_PATH = join(STATE_DIR, 'sidecar-memory.jsonl');
const backendCooldownUntil = new Map<ModelBackendKind, number>();
const sidecarCallSequences = new Map<string, string[]>();

export function resolveOpenAiModelSpec(model: SupportedModelProfile): OpenAiModelSpec {
  const routerModel = process.env.ORGANISM_OPENAI_ROUTER_MODEL
    ?? process.env.ORGANISM_OPENAI_SMALL_MODEL
    ?? 'gpt-5.4';
  const defaultModel = process.env.ORGANISM_OPENAI_DEFAULT_MODEL
    ?? process.env.ORGANISM_OPENAI_FALLBACK_MODEL
    ?? 'gpt-5.4';
  const deepModel = process.env.ORGANISM_OPENAI_DEEP_MODEL
    ?? defaultModel
    ?? 'gpt-5.4';
  const reviewModel = process.env.ORGANISM_OPENAI_REVIEW_MODEL ?? 'gpt-5.4';
  const reviewCliModel = process.env.ORGANISM_OPENAI_REVIEW_CLI_MODEL
    ?? process.env.ORGANISM_OPENAI_DEFAULT_MODEL
    ?? 'gpt-5.4';

  switch (model) {
    case 'haiku':
      return { cliModel: routerModel, apiModel: routerModel, reasoningEffort: 'low' };
    case 'sonnet':
      return { cliModel: defaultModel, apiModel: defaultModel, reasoningEffort: 'medium' };
    case 'opus':
      return { cliModel: deepModel, apiModel: deepModel, reasoningEffort: 'high' };
    case 'gpt4o':
      return { cliModel: reviewCliModel, apiModel: reviewModel, reasoningEffort: 'low' };
    case 'gpt5.4':
      return { cliModel: 'gpt-5.4', apiModel: 'gpt-5.4', reasoningEffort: 'medium' };
  }
}

function resolveSidecarPreference(preference?: SidecarPreference): SidecarPreference {
  if (preference) return preference;

  const envPreference = process.env.ORGANISM_SIDECAR_MODE;
  if (
    envPreference === 'auto'
    || envPreference === 'embedded'
    || envPreference === 'external'
    || envPreference === 'disabled'
  ) {
    return envPreference;
  }

  return 'embedded';
}

function resolvePythonCommand(): 'python' | 'py' | null {
  if (commandExists('python')) return 'python';
  if (commandExists('py')) return 'py';
  return null;
}

function externalSidecarAvailable(): boolean {
  return resolvePythonCommand() !== null && existsSync(SIDECAR_SERVER_PATH);
}

export function resolveSidecarStatus(preference?: SidecarPreference): SidecarStatus {
  const preferred = resolveSidecarPreference(preference);
  const externalAvailable = externalSidecarAvailable();

  if (preferred === 'disabled') {
    return {
      preferred,
      selected: 'disabled',
      tools: [...SIDECAR_TOOL_NAMES],
      externalAvailable,
      scriptPath: SIDECAR_SERVER_PATH,
    };
  }

  if (preferred === 'external') {
    if (!externalAvailable) {
      throw new Error(`${OrganismError.MCP_SIDECAR_UNREACHABLE}: external PraisonAI sidecar is unavailable`);
    }
    return {
      preferred,
      selected: 'external',
      tools: [...SIDECAR_TOOL_NAMES],
      externalAvailable,
      scriptPath: SIDECAR_SERVER_PATH,
    };
  }

  return {
    preferred,
    selected: preferred === 'auto' && externalAvailable ? 'external' : 'embedded',
    tools: [...SIDECAR_TOOL_NAMES],
    externalAvailable,
    scriptPath: SIDECAR_SERVER_PATH,
  };
}

function supportsReasoningEffort(model: string): boolean {
  return /^gpt-5/i.test(model);
}

// ── Rate limit tracking ───────────────────────────────────────────────────
// Claude CLI can rate limit interactive subscriptions. When that happens we
// parse the reset time and pause agent work until the limit resets.

let _rateLimitResetAt: number | null = null;
let _rateLimitUsagePct = 0;
let _sessionCostUsd = 0;
const COST_LIMIT_ESTIMATE = 50.0;

function commandExists(command: string): boolean {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}

function resolveCommandPath(command: string): string {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`Command "${command}" is not available on PATH`);
  }
  const candidates = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (candidates.length === 0) {
    throw new Error(`Unable to resolve command path for "${command}"`);
  }
  if (process.platform === 'win32') {
    const preferred = candidates.find((candidate) => /\.(cmd|bat|exe)$/i.test(candidate));
    if (preferred) return preferred;
  }
  return candidates[0]!;
}

function spawnCliCommand(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const resolved = resolveCommandPath(command);
  const isWindowsCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  if (isWindowsCmd) {
    return spawn('cmd.exe', ['/d', '/s', '/c', resolved, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env,
    });
  }

  return spawn(resolved, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    env,
  });
}

export interface SidecarStoredMemory {
  id: string;
  fact: string;
  context?: Record<string, unknown>;
}

function readPersistedSidecarMemory(): SidecarStoredMemory[] {
  try {
    if (!existsSync(SIDECAR_MEMORY_PATH)) return [];
    return readFileSync(SIDECAR_MEMORY_PATH, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SidecarStoredMemory];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function callExternalSidecarTool<T>(tool: SidecarToolName, args: Record<string, unknown>): Promise<T> {
  const pythonCommand = resolvePythonCommand();
  if (!pythonCommand) {
    throw new Error(`${OrganismError.MCP_SIDECAR_UNREACHABLE}: python runtime unavailable for PraisonAI sidecar`);
  }

  return new Promise((resolve, reject) => {
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    const system = typeof args.system === 'string' ? args.system : undefined;
    const maxTokens = typeof args.max_tokens === 'number' ? args.max_tokens : 2048;
    const timeoutMs = Math.min(resolveAdaptiveModelTimeout(prompt, system, maxTokens), 10 * 60 * 1000);

    const child = spawnCliCommand(pythonCommand, [SIDECAR_SERVER_PATH, '--cli', tool], process.cwd(), { ...process.env });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${OrganismError.MCP_SIDECAR_UNREACHABLE}: PraisonAI sidecar timed out after ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (code !== 0) {
        reject(new Error(`${OrganismError.MCP_SIDECAR_UNREACHABLE}: PraisonAI sidecar exited ${code}${stderr ? ` — ${stderr}` : ''}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as T);
      } catch (error) {
        reject(new Error(`${OrganismError.MCP_SIDECAR_UNREACHABLE}: PraisonAI sidecar returned invalid JSON (${error instanceof Error ? error.message : String(error)})`));
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${OrganismError.MCP_SIDECAR_UNREACHABLE}: PraisonAI sidecar spawn error — ${error.message}`));
    });

    child.stdin.write(JSON.stringify(args));
    child.stdin.end();
  });
}

async function callEmbeddedSidecarTool<T>(tool: SidecarToolName, args: Record<string, unknown>): Promise<T> {
  switch (tool) {
    case 'route_model': {
      const modelPreference = (args.model_preference as SupportedModelProfile | undefined) ?? 'sonnet';
      const prompt = String(args.prompt ?? '');
      const system = typeof args.system === 'string' ? args.system : undefined;
      const maxTokens = typeof args.max_tokens === 'number' ? args.max_tokens : 2048;
      const result = await callSelectedBackendDirect(prompt, modelPreference, system, maxTokens);
      return {
        content: result.text,
        model: modelPreference,
        tokens_in: result.inputTokens,
        tokens_out: result.outputTokens,
      } as T;
    }
    case 'rag_retrieve': {
      const query = String(args.query ?? '').trim().toLowerCase();
      const k = typeof args.k === 'number' ? Math.max(1, Math.trunc(args.k)) : 5;
      const queryWords = new Set(query.split(/\s+/).filter(Boolean));
      const memoryEntries = readPersistedSidecarMemory();
      const results = memoryEntries
        .map((entry) => {
          const factWords = new Set(entry.fact.toLowerCase().split(/\s+/).filter(Boolean));
          let score = 0;
          for (const word of queryWords) {
            if (factWords.has(word)) score += 1;
          }
          return { score, entry };
        })
        .filter((row) => row.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, k)
        .map((row) => row.entry);

      return {
        results,
        total_in_store: memoryEntries.length,
      } as T;
    }
    case 'check_policy': {
      const action = String(args.action ?? '');
      const blockedActions: Array<[string, string]> = [
        ['delete user data', 'E001: User data deletion requires explicit human approval'],
        ['drop table', 'E001: Database destructive operations are blocked'],
        ['push --force', 'Engineering agent git rules: force push is blocked'],
        ['git reset --hard', 'Engineering agent git rules: hard reset is blocked'],
      ];

      const actionLower = action.toLowerCase();
      for (const [pattern, reason] of blockedActions) {
        if (actionLower.includes(pattern)) {
          return {
            result: 'FAIL',
            reason,
            action,
          } as T;
        }
      }

      return {
        result: 'PASS',
        reason: 'No policy violations detected',
        action,
      } as T;
    }
    case 'detect_doom_loop': {
      const sequence = Array.isArray(args.call_sequence)
        ? args.call_sequence.filter((item): item is string => typeof item === 'string')
        : [];
      const agentId = String(args.agent_id ?? 'unknown');
      const history = sidecarCallSequences.get(agentId) ?? [];
      sidecarCallSequences.set(agentId, [...history, ...sequence].slice(-50));

      if (sequence.length >= 3) {
        for (let index = 0; index <= sequence.length - 3; index += 1) {
          if (sequence[index] === sequence[index + 1] && sequence[index] === sequence[index + 2]) {
            return {
              signal: true,
              code: OrganismError.DOOM_LOOP_DETECTED,
              evidence: `Action '${sequence[index]}' repeated 3 times consecutively`,
              recommendation: 'Break the loop: add a stop condition or escalate to CEO',
            } as T;
          }
        }
      }

      if (sequence.length >= 4) {
        const fingerprint = createHash('md5').update(JSON.stringify(sequence.slice(-4))).digest('hex');
        const fingerprintKey = `${agentId}:fingerprints`;
        const fingerprintHistory = sidecarCallSequences.get(fingerprintKey) ?? [];
        if (fingerprintHistory.includes(fingerprint)) {
          return {
            signal: true,
            code: OrganismError.DOOM_LOOP_DETECTED,
            evidence: `Sequence fingerprint ${fingerprint.slice(0, 8)} seen before (cycle)`,
            recommendation: 'Agent is cycling — stop and report to orchestrator',
          } as T;
        }
        sidecarCallSequences.set(fingerprintKey, [...fingerprintHistory, fingerprint].slice(-20));
      }

      return {
        signal: false,
        evidence: 'No doom loop detected',
      } as T;
    }
    case 'persist_memory': {
      const fact = String(args.fact ?? '').trim();
      const graphContext = args.graph_context && typeof args.graph_context === 'object'
        ? args.graph_context as Record<string, unknown>
        : {};
      const entry: SidecarStoredMemory = {
        id: createHash('sha256').update(fact).digest('hex').slice(0, 16),
        fact,
        context: graphContext,
      };

      const existing = readPersistedSidecarMemory();
      if (!existing.some((item) => item.id === entry.id)) {
        mkdirSync(STATE_DIR, { recursive: true });
        appendFileSync(SIDECAR_MEMORY_PATH, JSON.stringify(entry) + '\n', 'utf8');
      }

      return {
        status: 'persisted',
        id: entry.id,
        total_in_store: readPersistedSidecarMemory().length,
      } as T;
    }
  }

  const unreachableTool: never = tool;
  throw new Error(`Unknown sidecar tool: ${String(unreachableTool)}`);
}

async function callSidecarTool<T>(tool: SidecarToolName, args: Record<string, unknown>): Promise<T> {
  const status = resolveSidecarStatus();

  if (status.selected === 'external') {
    try {
      return await callExternalSidecarTool<T>(tool, args);
    } catch (error) {
      if (status.preferred !== 'external') {
        console.warn(`[Sidecar] External PraisonAI sidecar failed (${errorMessage(error)}). Falling back to embedded contract.`);
        return callEmbeddedSidecarTool<T>(tool, args);
      }
      throw error;
    }
  }

  return callEmbeddedSidecarTool<T>(tool, args);
}

export async function routeModelViaSidecar(
  prompt: string,
  model: SupportedModelProfile,
  systemPrompt: string | undefined,
  maxTokens: number,
): Promise<ModelCallResult> {
  const status = resolveSidecarStatus();
  if (status.selected === 'disabled') {
    return callSelectedBackendDirect(prompt, model, systemPrompt, maxTokens);
  }

  const result = await callSidecarTool<{
    content?: string;
    tokens_in?: number;
    tokens_out?: number;
    error?: string;
  }>('route_model', {
    prompt,
    model_preference: model,
    system: systemPrompt,
    max_tokens: maxTokens,
  });

  if (result.error) {
    throw new Error(result.error);
  }

  return {
    text: result.content ?? '',
    inputTokens: result.tokens_in ?? 0,
    outputTokens: result.tokens_out ?? 0,
  };
}

export async function checkPolicyViaSidecar(action: string, context: Record<string, unknown> = {}): Promise<{
  result: 'PASS' | 'FAIL';
  reason: string;
  action: string;
}> {
  return callSidecarTool<{
    result: 'PASS' | 'FAIL';
    reason: string;
    action: string;
  }>('check_policy', { action, context });
}

export async function detectDoomLoopViaSidecar(callSequence: string[], agentId: string): Promise<{
  signal: boolean;
  code?: string;
  evidence: string;
  recommendation?: string;
}> {
  return callSidecarTool<{
    signal: boolean;
    code?: string;
    evidence: string;
    recommendation?: string;
  }>('detect_doom_loop', {
    call_sequence: callSequence,
    agent_id: agentId,
  });
}

export async function persistMemoryViaSidecar(fact: string, graphContext: Record<string, unknown> = {}): Promise<{
  status: string;
  id: string;
  total_in_store: number;
}> {
  return callSidecarTool<{
    status: string;
    id: string;
    total_in_store: number;
  }>('persist_memory', {
    fact,
    graph_context: graphContext,
  });
}

export async function ragRetrieveViaSidecar(query: string, k = 5): Promise<{
  results: SidecarStoredMemory[];
  total_in_store: number;
}> {
  return callSidecarTool<{
    results: SidecarStoredMemory[];
    total_in_store: number;
  }>('rag_retrieve', { query, k });
}

export async function probeSidecarStatus(preference?: SidecarPreference): Promise<SidecarStatus & { fallbackReason?: string | null }> {
  const status = resolveSidecarStatus(preference);

  if (status.selected === 'disabled') {
    return { ...status, fallbackReason: 'PraisonAI sidecar contract is explicitly disabled.' };
  }

  if (status.selected === 'external') {
    try {
      await callExternalSidecarTool('check_policy', {
        action: 'git status',
        context: { probe: true },
      });
      return { ...status, fallbackReason: null };
    } catch (error) {
      if (status.preferred !== 'external') {
        return {
          ...status,
          selected: 'embedded',
          fallbackReason: errorMessage(error),
        };
      }
      throw error;
    }
  }

  return { ...status, fallbackReason: null };
}

function availableModelBackends(): ModelBackendAvailability {
  return {
    claudeCli: commandExists('claude'),
    anthropicApi: Boolean(getSecretOrNull('ANTHROPIC_API_KEY')),
    codexCli: commandExists('codex'),
    openaiApi: Boolean(getSecretOrNull('OPENAI_API_KEY')),
  };
}

function loadBackendCooldowns(): void {
  if (backendCooldownUntil.size > 0) return;
  if (!existsSync(BACKEND_HEALTH_PATH)) return;
  try {
    const raw = JSON.parse(readFileSync(BACKEND_HEALTH_PATH, 'utf8')) as Partial<Record<ModelBackendKind, number>>;
    for (const backend of ['claude-cli', 'anthropic-api', 'codex-cli', 'openai-api'] as const) {
      const until = raw[backend];
      if (typeof until === 'number' && Number.isFinite(until) && until > Date.now()) {
        backendCooldownUntil.set(backend, until);
      }
    }
  } catch {
    // Ignore corrupted cooldown files and rebuild them on the next write.
  }
}

function persistBackendCooldowns(): void {
  mkdirSync(join(homedir(), '.organism', 'state'), { recursive: true });
  const payload: Partial<Record<ModelBackendKind, number>> = {};
  for (const [backend, until] of backendCooldownUntil.entries()) {
    if (until > Date.now()) {
      payload[backend] = until;
    }
  }
  writeFileSync(BACKEND_HEALTH_PATH, JSON.stringify(payload, null, 2));
}

function backendOnCooldown(backend: ModelBackendKind): boolean {
  loadBackendCooldowns();
  const until = backendCooldownUntil.get(backend);
  if (!until) return false;
  if (until <= Date.now()) {
    backendCooldownUntil.delete(backend);
    persistBackendCooldowns();
    return false;
  }
  return true;
}

function clearBackendCooldown(backend: ModelBackendKind): void {
  loadBackendCooldowns();
  if (!backendCooldownUntil.has(backend)) return;
  backendCooldownUntil.delete(backend);
  persistBackendCooldowns();
}

function classifyBackendFailure(error: unknown): BackendFailureClass {
  const message = errorMessage(error).toLowerCase();
  if (message.includes('credit balance is too low') || message.includes('insufficient') || message.includes('quota') || message.includes('billing')) {
    return 'credit';
  }
  if (message.includes('rate limit') || message.includes('rate_limited') || message.includes('429') || message.includes('529')) {
    return 'rate_limit';
  }
  if (
    message.includes('connection error')
    || message.includes('fetch failed')
    || message.includes('network error')
    || message.includes('socket hang up')
    || message.includes('econnreset')
    || message.includes('econnrefused')
    || message.includes('transport')
    || message.includes('timed out')
    || message.includes('timeout')
  ) {
    return 'transport';
  }
  if (
    message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('401')
    || message.includes('403')
    || message.includes('invalid api key')
    || message.includes('login')
  ) {
    return 'auth';
  }
  return 'generic';
}

function backendCooldownMs(backend: ModelBackendKind, failure: BackendFailureClass): number {
  switch (failure) {
    case 'credit':
      return backend === 'claude-cli' || backend === 'anthropic-api'
        ? 6 * 60 * 60 * 1000
        : 60 * 60 * 1000;
    case 'rate_limit':
      return 30 * 60 * 1000;
    case 'transport':
      return 15 * 60 * 1000;
    case 'auth':
      return 60 * 60 * 1000;
    default:
      return 10 * 60 * 1000;
  }
}

function markBackendCooldown(backend: ModelBackendKind, error: unknown): void {
  loadBackendCooldowns();
  backendCooldownUntil.set(backend, Date.now() + backendCooldownMs(backend, classifyBackendFailure(error)));
  persistBackendCooldowns();
}

function resolveBackendPreference(preference?: ModelBackendPreference): ModelBackendPreference {
  if (preference) return preference;

  const envPreference = process.env.ORGANISM_MODEL_BACKEND;
  if (
    envPreference === 'claude-cli'
    || envPreference === 'anthropic-api'
    || envPreference === 'codex-cli'
    || envPreference === 'openai-api'
    || envPreference === 'codex-first'
    || envPreference === 'auto'
  ) {
    return envPreference;
  }

  if (process.env.USE_API_DIRECT === 'true') return 'anthropic-api';
  return 'auto';
}

export function resolveModelBackend(
  preference?: ModelBackendPreference,
  available = availableModelBackends(),
): ModelBackendStatus {
  const requested = resolveBackendPreference(preference);

  if (requested === 'claude-cli') {
    if (!available.claudeCli) {
      throw new Error('Requested model backend "claude-cli" is not available on PATH');
    }
    return {
      preferred: requested,
      selected: requested,
      available,
      capabilities: { webSearch: true, cliRateLimits: true },
    };
  }

  if (requested === 'anthropic-api') {
    if (!available.anthropicApi) {
      throw new Error('Requested model backend "anthropic-api" requires ANTHROPIC_API_KEY');
    }
    return {
      preferred: requested,
      selected: requested,
      available,
      capabilities: { webSearch: false, cliRateLimits: false },
    };
  }

  if (requested === 'codex-cli') {
    if (!available.codexCli) {
      throw new Error('Requested model backend "codex-cli" is not available on PATH');
    }
    return {
      preferred: requested,
      selected: requested,
      available,
      capabilities: { webSearch: false, cliRateLimits: false },
    };
  }

  if (requested === 'openai-api') {
    if (!available.openaiApi) {
      throw new Error('Requested model backend "openai-api" requires OPENAI_API_KEY');
    }
    return {
      preferred: requested,
      selected: requested,
      available,
      capabilities: { webSearch: false, cliRateLimits: false },
    };
  }

  if (requested === 'codex-first') {
    if (available.codexCli && !backendOnCooldown('codex-cli')) {
      return {
        preferred: requested,
        selected: 'codex-cli',
        available,
        capabilities: { webSearch: false, cliRateLimits: false },
      };
    }

    if (available.openaiApi && !backendOnCooldown('openai-api')) {
      return {
        preferred: requested,
        selected: 'openai-api',
        available,
        capabilities: { webSearch: false, cliRateLimits: false },
      };
    }

    if (available.claudeCli && !backendOnCooldown('claude-cli')) {
      return {
        preferred: requested,
        selected: 'claude-cli',
        available,
        capabilities: { webSearch: true, cliRateLimits: true },
      };
    }

    if (available.anthropicApi && !backendOnCooldown('anthropic-api')) {
      return {
        preferred: requested,
        selected: 'anthropic-api',
        available,
        capabilities: { webSearch: false, cliRateLimits: false },
      };
    }

    if (available.codexCli) {
      return {
        preferred: requested,
        selected: 'codex-cli',
        available,
        capabilities: { webSearch: false, cliRateLimits: false },
      };
    }

    if (available.openaiApi) {
      return {
        preferred: requested,
        selected: 'openai-api',
        available,
        capabilities: { webSearch: false, cliRateLimits: false },
      };
    }

    if (available.claudeCli) {
      return {
        preferred: requested,
        selected: 'claude-cli',
        available,
        capabilities: { webSearch: true, cliRateLimits: true },
      };
    }

    if (available.anthropicApi) {
      return {
        preferred: requested,
        selected: 'anthropic-api',
        available,
        capabilities: { webSearch: false, cliRateLimits: false },
      };
    }
  }

  if (available.codexCli && !backendOnCooldown('codex-cli')) {
    return {
      preferred: 'auto',
      selected: 'codex-cli',
      available,
      capabilities: { webSearch: false, cliRateLimits: false },
    };
  }

  if (available.claudeCli && !backendOnCooldown('claude-cli')) {
    return {
      preferred: 'auto',
      selected: 'claude-cli',
      available,
      capabilities: { webSearch: true, cliRateLimits: true },
    };
  }

  if (available.openaiApi && !backendOnCooldown('openai-api')) {
    return {
      preferred: 'auto',
      selected: 'openai-api',
      available,
      capabilities: { webSearch: false, cliRateLimits: false },
    };
  }

  if (available.anthropicApi && !backendOnCooldown('anthropic-api')) {
    return {
      preferred: 'auto',
      selected: 'anthropic-api',
      available,
      capabilities: { webSearch: false, cliRateLimits: false },
    };
  }

  if (available.codexCli) {
    return {
      preferred: 'auto',
      selected: 'codex-cli',
      available,
      capabilities: { webSearch: false, cliRateLimits: false },
    };
  }

  if (available.claudeCli) {
    return {
      preferred: 'auto',
      selected: 'claude-cli',
      available,
      capabilities: { webSearch: true, cliRateLimits: true },
    };
  }

  if (available.openaiApi) {
    return {
      preferred: 'auto',
      selected: 'openai-api',
      available,
      capabilities: { webSearch: false, cliRateLimits: false },
    };
  }

  if (available.anthropicApi) {
    return {
      preferred: 'auto',
      selected: 'anthropic-api',
      available,
      capabilities: { webSearch: false, cliRateLimits: false },
    };
  }

  throw new Error(
    'No supported model backend found. Install Claude Code or Codex CLI, or set ANTHROPIC_API_KEY / OPENAI_API_KEY.',
  );
}

function selectedBackendUsesClaudeCli(): boolean {
  try {
    return resolveModelBackend().selected === 'claude-cli';
  } catch {
    return false;
  }
}

function claudeCliRateLimited(): boolean {
  if (!_rateLimitResetAt) {
    try {
      const filePath = join(homedir(), '.organism', 'state', 'cli-rate-limit.json');
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf8')) as { resetsAt?: number };
        if (data.resetsAt && Date.now() < data.resetsAt) {
          _rateLimitResetAt = data.resetsAt;
        } else {
          unlinkSync(filePath);
        }
      }
    } catch {
      // Ignore corrupted or missing external rate limit hints.
    }
  }

  if (!_rateLimitResetAt) return false;
  if (Date.now() >= _rateLimitResetAt) {
    _rateLimitResetAt = null;
    return false;
  }
  return true;
}

export function isRateLimited(): boolean {
  if (!selectedBackendUsesClaudeCli()) return false;
  if (!claudeCliRateLimited()) return false;

  try {
    const backend = resolveModelBackend();
    if (
      backend.preferred === 'auto'
      && (backend.available.anthropicApi || backend.available.codexCli || backend.available.openaiApi)
    ) {
      return false;
    }
  } catch {
    // Fall through to the conservative rate-limited answer.
  }

  return true;
}

export function getRateLimitStatus(): {
  limited: boolean;
  resetsAt: number | null;
  usagePct: number;
  sessionCost: number;
  backend: ModelBackendKind | null;
} {
  let backend: ModelBackendKind | null = null;
  try {
    backend = resolveModelBackend().selected;
  } catch {
    backend = null;
  }

  return {
    limited: isRateLimited(),
    resetsAt: _rateLimitResetAt,
    usagePct: _rateLimitUsagePct,
    sessionCost: _sessionCostUsd,
    backend,
  };
}

function parseResetTime(errorMsg: string): number | null {
  const match = errorMsg.match(/resets?\s+(\d{1,2})(am|pm)\s*\(?([\w/]+)?\)?/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const ampm = match[2].toLowerCase();
  const tz = match[3] || 'Australia/Sydney';

  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', hour12: false });
  const currentHourInTz = parseInt(formatter.format(now), 10);

  let hoursUntilReset = hour - currentHourInTz;
  if (hoursUntilReset <= 0) hoursUntilReset += 24;

  return Date.now() + hoursUntilReset * 60 * 60 * 1000;
}

function checkForRateLimit(errorMsg: string): boolean {
  if (!errorMsg.includes('hit your limit') && !errorMsg.includes('rate limit')) return false;

  const resetAt = parseResetTime(errorMsg);
  if (resetAt) {
    _rateLimitResetAt = resetAt;
    const resetDate = new Date(resetAt);
    console.log(
      `[RateLimit] Hit limit. Auto-resume at ${resetDate.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}`,
    );
  } else {
    _rateLimitResetAt = Date.now() + 60 * 60 * 1000;
    console.log('[RateLimit] Hit limit. Cannot parse reset time — retrying in 1 hour.');
  }

  _rateLimitUsagePct = 100;
  return true;
}

function trackCost(costUsd: number): void {
  _sessionCostUsd += costUsd;
  _rateLimitUsagePct = Math.min(100, (_sessionCostUsd / COST_LIMIT_ESTIMATE) * 100);
  if (_rateLimitUsagePct >= 95) {
    console.warn(
      `[RateLimit] Session cost $${_sessionCostUsd.toFixed(2)} — estimated ${_rateLimitUsagePct.toFixed(0)}% of limit. Approaching cap.`,
    );
  }
}

export interface ModelCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

const MIN_MODEL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_MODEL_TIMEOUT_MS = 45 * 60 * 1000;

export function resolveAdaptiveModelTimeout(prompt: string, systemPrompt: string | undefined, maxTokens: number): number {
  const combinedLength = prompt.length + (systemPrompt?.length ?? 0);
  let timeoutMs = MIN_MODEL_TIMEOUT_MS;

  if (combinedLength > 10_000) timeoutMs += 5 * 60 * 1000;
  if (combinedLength > 25_000) timeoutMs += 10 * 60 * 1000;
  if (maxTokens > 4_096) timeoutMs += 5 * 60 * 1000;
  if (/repo brief|self-audit|autonomy-cycle|canary review|project review/i.test(prompt)) {
    timeoutMs += 5 * 60 * 1000;
  }

  return Math.min(MAX_MODEL_TIMEOUT_MS, timeoutMs);
}

async function withModelTimeout<T>(promiseFactory: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promiseFactory(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 60_000)} minutes`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ClaudeJsonResult {
  result: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }>;
  is_error?: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

export function shouldFallbackFromClaudeCliToApi(error: unknown): boolean {
  const message = errorMessage(error);
  return /credit balance is too low|RATE_LIMITED|rate limit|429|529|overloaded|connection error|fetch failed|network error|spawn error|timed out|timeout|UNSUPPORTED_MODEL/i.test(message);
}

export function shouldFallbackFromAnthropicToOpenAi(error: unknown): boolean {
  const message = errorMessage(error);
  return /credit balance is too low|insufficient|rate limit|429|529|overloaded|401|403|unauthorized|connection error|fetch failed|network error|socket hang up|econnreset|econnrefused|transport|timed out|timeout/i.test(message);
}

export function shouldFallbackFromCodexCli(error: unknown): boolean {
  const message = errorMessage(error);
  return /rate limit|429|403|401|unauthorized|login|quota|billing|credit|usage limit|insufficient|connection error|fetch failed|network error|timed out|timeout/i.test(message);
}

function buildPrompt(prompt: string, systemPrompt?: string): string {
  return systemPrompt
    ? `<system-instructions>\n${systemPrompt}\n</system-instructions>\n\n${prompt}`
    : prompt;
}

function callClaude(
  prompt: string,
  model: string,
  systemPrompt?: string,
  maxTokens = 2048,
): Promise<ModelCallResult> {
  return new Promise((resolve, reject) => {
    if (/^gpt/i.test(model)) {
      reject(new Error(`UNSUPPORTED_MODEL: claude CLI cannot run OpenAI model "${model}" — routing to OpenAI backend`));
      return;
    }

    const args = [
      '-p',
      '--model', MODEL_ALIASES[model as LogicalModelProfile] ?? model,
      '--output-format', 'json',
      '--no-session-persistence',
    ];

    const fullPrompt = buildPrompt(prompt, systemPrompt);

    const child = spawnCliCommand('claude', args, process.cwd(), { ...process.env });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const timeoutMs = resolveAdaptiveModelTimeout(prompt, systemPrompt, maxTokens);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude CLI timed out after ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');

      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude CLI exited ${code}: ${stderr}`));
        return;
      }

      try {
        const data = JSON.parse(stdout) as ClaudeJsonResult;

        if (data.is_error) {
          const errMsg = data.result ?? '';
          if (checkForRateLimit(errMsg)) {
            reject(new Error(`RATE_LIMITED: ${errMsg}`));
            return;
          }
          reject(new Error(`claude CLI returned error: ${errMsg}`));
          return;
        }

        if (data.modelUsage) {
          for (const usage of Object.values(data.modelUsage)) {
            if ((usage as Record<string, unknown>).costUSD) {
              trackCost((usage as Record<string, unknown>).costUSD as number);
            }
          }
        }

        let inputTokens = 0;
        let outputTokens = 0;

        if (data.modelUsage) {
          for (const usage of Object.values(data.modelUsage)) {
            inputTokens += (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
            outputTokens += usage.outputTokens ?? 0;
          }
        } else if (data.usage) {
          inputTokens = (data.usage.input_tokens ?? 0)
            + (data.usage.cache_creation_input_tokens ?? 0)
            + (data.usage.cache_read_input_tokens ?? 0);
          outputTokens = data.usage.output_tokens ?? 0;
        }

        resolve({
          text: data.result ?? '',
          inputTokens,
          outputTokens,
        });
      } catch {
        resolve({
          text: stdout.trim(),
          inputTokens: 0,
          outputTokens: 0,
        });
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI spawn error: ${error.message}`));
    });

    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

function callCodexCli(
  prompt: string,
  model: SupportedModelProfile,
  systemPrompt?: string,
  maxTokens = 2048,
): Promise<ModelCallResult> {
  return new Promise((resolve, reject) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'organism-model-codex-'));
    const outputFile = join(tempDir, 'last-message.txt');
    const resolvedModel = resolveOpenAiModelSpec(model).cliModel;
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--ephemeral',
      '--model', resolvedModel,
      '-o', outputFile,
      '-',
    ];

    const child = spawnCliCommand('codex', args, process.cwd(), { ...process.env });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timeoutMs = resolveAdaptiveModelTimeout(prompt, systemPrompt, maxTokens);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`codex CLI timed out after ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const rawOutput = `${stdout}${stderr}`.trim();
        const text = existsSync(outputFile) ? readFileSync(outputFile, 'utf8').trim() : '';

        if (code !== 0 && !text) {
          reject(new Error(`codex CLI exited ${code}: ${rawOutput}`));
          return;
        }

        resolve({
          text: text || stdout.trim(),
          inputTokens: 0,
          outputTokens: 0,
        });
      } catch (error) {
        reject(new Error(`codex CLI failed to read output: ${error instanceof Error ? error.message : String(error)}`));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      rmSync(tempDir, { recursive: true, force: true });
      reject(new Error(`codex CLI spawn error: ${error.message}`));
    });

    child.stdin.write(buildPrompt(prompt, systemPrompt));
    child.stdin.end();
  });
}

async function callApiDirect(
  prompt: string,
  model: string,
  systemPrompt?: string,
  maxTokens = 8192,
): Promise<ModelCallResult> {
  interface AnthropicTextBlock {
    type: string;
    text?: string;
  }

  interface AnthropicMessageResponse {
    content: AnthropicTextBlock[];
    usage: {
      input_tokens: number;
      output_tokens: number;
    };
  }

  interface AnthropicMessagesApi {
    create(args: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: Array<{ role: 'user'; content: string }>;
    }): Promise<AnthropicMessageResponse>;
  }

  interface AnthropicClient {
    messages: AnthropicMessagesApi;
  }

  interface AnthropicModule {
    default: new (options: { apiKey: string }) => AnthropicClient;
  }

  const MODEL_IDS: Record<string, string> = {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-6',
  };

  const importAnthropic = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<AnthropicModule>;
  const { default: Anthropic } = await importAnthropic('@anthropic-ai/sdk').catch((error) => {
    throw new Error(
      `Selected model backend "anthropic-api" is unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const apiKey = getSecretOrNull('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('Selected model backend "anthropic-api" requires ANTHROPIC_API_KEY');
  }

  const client = new Anthropic({ apiKey });
  const timeoutMs = resolveAdaptiveModelTimeout(prompt, systemPrompt, maxTokens);
  const response = await withModelTimeout(
    () => client.messages.create({
      model: MODEL_IDS[model] ?? model,
      max_tokens: maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
    timeoutMs,
    'Anthropic API',
  );

  const text = response.content
    .filter((block): block is AnthropicTextBlock & { text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

interface OpenAIResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

async function callOpenAiDirect(
  prompt: string,
  model: SupportedModelProfile,
  systemPrompt?: string,
  maxTokens = 8192,
): Promise<ModelCallResult> {
  const apiKey = getSecretOrNull('OPENAI_API_KEY');
  if (!apiKey) {
    throw new Error('Selected model backend "openai-api" requires OPENAI_API_KEY');
  }

  const modelSpec = resolveOpenAiModelSpec(model);
  const timeoutMs = resolveAdaptiveModelTimeout(prompt, systemPrompt, maxTokens);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelSpec.apiModel,
        max_completion_tokens: maxTokens,
        ...(supportsReasoningEffort(modelSpec.apiModel) ? { reasoning_effort: modelSpec.reasoningEffort } : {}),
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`OpenAI API timed out after ${Math.round(timeoutMs / 60_000)} minutes`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
  }

  const data = await response.json() as OpenAIResponse;
  return {
    text: data.choices[0]?.message?.content ?? '',
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

function autoFallbackOrder(status: ModelBackendStatus): ModelBackendKind[] {
  const candidates: ModelBackendKind[] = status.preferred === 'codex-first'
    ? ['codex-cli', 'openai-api', 'claude-cli', 'anthropic-api']
    : ['codex-cli', 'claude-cli', 'openai-api', 'anthropic-api'];

  const prioritized = candidates.filter((backend) => {
    switch (backend) {
      case 'claude-cli':
        return status.available.claudeCli && !claudeCliRateLimited() && !backendOnCooldown('claude-cli');
      case 'anthropic-api':
        return status.available.anthropicApi && !backendOnCooldown('anthropic-api');
      case 'codex-cli':
        return status.available.codexCli && !backendOnCooldown('codex-cli');
      case 'openai-api':
        return status.available.openaiApi && !backendOnCooldown('openai-api');
    }
  });

  if (prioritized.length > 0) {
    return prioritized;
  }

  return candidates.filter((backend) => {
    switch (backend) {
      case 'claude-cli':
        return status.available.claudeCli && !claudeCliRateLimited();
      case 'anthropic-api':
        return status.available.anthropicApi;
      case 'codex-cli':
        return status.available.codexCli;
      case 'openai-api':
        return status.available.openaiApi;
    }
  });
}

async function callBackend(
  backend: ModelBackendKind,
  prompt: string,
  model: SupportedModelProfile,
  systemPrompt: string | undefined,
  maxTokens: number,
): Promise<ModelCallResult> {
  switch (backend) {
    case 'claude-cli':
      return callClaude(prompt, model, systemPrompt, maxTokens);
    case 'anthropic-api':
      return callApiDirect(prompt, model, systemPrompt, maxTokens);
    case 'codex-cli':
      return callCodexCli(prompt, model, systemPrompt, maxTokens);
    case 'openai-api':
      return callOpenAiDirect(prompt, model, systemPrompt, maxTokens);
  }
}

function shouldTryNextBackend(backend: ModelBackendKind, error: unknown): boolean {
  switch (backend) {
    case 'claude-cli':
      return shouldFallbackFromClaudeCliToApi(error);
    case 'anthropic-api':
      return shouldFallbackFromAnthropicToOpenAi(error);
    case 'codex-cli':
      return shouldFallbackFromCodexCli(error);
    case 'openai-api':
      return false;
  }
}

async function callSelectedBackendDirect(
  prompt: string,
  model: SupportedModelProfile,
  systemPrompt: string | undefined,
  maxTokens: number,
): Promise<ModelCallResult> {
  const backend = resolveModelBackend();
  if (backend.preferred !== 'auto' && backend.preferred !== 'codex-first') {
    return callBackend(backend.selected, prompt, model, systemPrompt, maxTokens);
  }

  const candidates = autoFallbackOrder(backend);
  let lastError: unknown = null;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    try {
      const result = await callBackend(candidate, prompt, model, systemPrompt, maxTokens);
      clearBackendCooldown(candidate);
      return result;
    } catch (error) {
      lastError = error;
      const next = candidates[index + 1];
      if (!next || !shouldTryNextBackend(candidate, error)) {
        throw error;
      }
      markBackendCooldown(candidate, error);
      console.warn(`[ModelBackend] ${candidate} failed (${errorMessage(error)}). Falling back to ${next}.`);
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Model backend failed')));
}

export async function callModel(
  prompt: string,
  model: 'haiku' | 'sonnet' | 'opus',
  systemPrompt?: string,
): Promise<ModelCallResult> {
  return routeModelViaSidecar(prompt, model, systemPrompt, 2048);
}

export async function callModelLong(
  prompt: string,
  model: 'haiku' | 'sonnet' | 'opus',
  systemPrompt?: string,
  maxTokens = 4096,
): Promise<ModelCallResult> {
  return routeModelViaSidecar(prompt, model, systemPrompt, maxTokens);
}

export async function callModelUltra(
  prompt: string,
  model: 'haiku' | 'sonnet' | 'opus',
  systemPrompt?: string,
): Promise<ModelCallResult> {
  return routeModelViaSidecar(prompt, model, systemPrompt, 8192);
}

export async function callNativeModel(
  prompt: string,
  model: Extract<SupportedModelProfile, 'gpt4o' | 'gpt5.4'>,
  systemPrompt?: string,
  maxTokens = 4096,
): Promise<ModelCallResult> {
  return routeModelViaSidecar(prompt, model, systemPrompt, maxTokens);
}
