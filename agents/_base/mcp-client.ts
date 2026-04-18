/**
 * MCP Client — shared Anthropic model access for Organism agents.
 *
 * Organism keeps its model discipline (Haiku/Sonnet/Opus), but the runtime
 * backend is configurable so the company can be launched smoothly from either
 * Claude Code or Codex:
 *
 * - `claude-cli`: use the local Claude CLI (`claude -p`)
 * - `anthropic-api`: use the Anthropic SDK with `ANTHROPIC_API_KEY`
 * - `auto` (default): prefer Codex CLI first to consume ChatGPT/Codex CLI
 *   capacity, then fall back to Claude CLI, OpenAI API, and finally the
 *   Anthropic API
 *
 * Legacy compatibility: `USE_API_DIRECT=true` still maps to
 * `ORGANISM_MODEL_BACKEND=anthropic-api`.
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { getSecretOrNull } from '../../packages/shared/src/secrets.js';

type LogicalModelProfile = 'haiku' | 'sonnet' | 'opus';
export type SupportedModelProfile = LogicalModelProfile | 'gpt4o' | 'gpt5.4';

const MODEL_ALIASES: Record<LogicalModelProfile, string> = {
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
};

export type ModelBackendKind = 'claude-cli' | 'anthropic-api' | 'codex-cli' | 'openai-api';
export type ModelBackendPreference = ModelBackendKind | 'auto';

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

interface OpenAiModelSpec {
  cliModel: string;
  apiModel: string;
  reasoningEffort: 'low' | 'medium' | 'high';
}

type BackendFailureClass = 'rate_limit' | 'credit' | 'transport' | 'auth' | 'generic';

const BACKEND_HEALTH_PATH = join(homedir(), '.organism', 'state', 'model-backend-health.json');
const backendCooldownUntil = new Map<ModelBackendKind, number>();

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
  const candidates: ModelBackendKind[] = [
    'codex-cli',
    'claude-cli',
    'openai-api',
    'anthropic-api',
  ];

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

async function callSelectedBackend(
  prompt: string,
  model: SupportedModelProfile,
  systemPrompt: string | undefined,
  maxTokens: number,
): Promise<ModelCallResult> {
  const backend = resolveModelBackend();
  if (backend.preferred !== 'auto') {
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
  return callSelectedBackend(prompt, model, systemPrompt, 2048);
}

export async function callModelLong(
  prompt: string,
  model: 'haiku' | 'sonnet' | 'opus',
  systemPrompt?: string,
  maxTokens = 4096,
): Promise<ModelCallResult> {
  return callSelectedBackend(prompt, model, systemPrompt, maxTokens);
}

export async function callModelUltra(
  prompt: string,
  model: 'haiku' | 'sonnet' | 'opus',
  systemPrompt?: string,
): Promise<ModelCallResult> {
  return callSelectedBackend(prompt, model, systemPrompt, 8192);
}

export async function callNativeModel(
  prompt: string,
  model: Extract<SupportedModelProfile, 'gpt4o' | 'gpt5.4'>,
  systemPrompt?: string,
  maxTokens = 4096,
): Promise<ModelCallResult> {
  return callSelectedBackend(prompt, model, systemPrompt, maxTokens);
}
