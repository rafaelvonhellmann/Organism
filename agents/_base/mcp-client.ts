/**
 * MCP Client — shared Anthropic model access for Organism agents.
 *
 * Organism keeps its model discipline (Haiku/Sonnet/Opus), but the runtime
 * backend is configurable so the company can be launched smoothly from either
 * Claude Code or Codex:
 *
 * - `claude-cli`: use the local Claude CLI (`claude -p`)
 * - `anthropic-api`: use the Anthropic SDK with `ANTHROPIC_API_KEY`
 * - `auto` (default): prefer Claude CLI for backward compatibility and built-in
 *   web search, otherwise fall back to the Anthropic API
 *
 * Legacy compatibility: `USE_API_DIRECT=true` still maps to
 * `ORGANISM_MODEL_BACKEND=anthropic-api`.
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { getSecretOrNull } from '../../packages/shared/src/secrets.js';

const MODEL_ALIASES: Record<string, string> = {
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

// ── Rate limit tracking ───────────────────────────────────────────────────
// Claude CLI can rate limit interactive subscriptions. When that happens we
// parse the reset time and pause agent work until the limit resets.

let _rateLimitResetAt: number | null = null;
let _rateLimitUsagePct = 0;
let _sessionCostUsd = 0;
const COST_LIMIT_ESTIMATE = 50.0;

function commandExists(command: string): boolean {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function availableModelBackends(): ModelBackendAvailability {
  return {
    claudeCli: commandExists('claude'),
    anthropicApi: Boolean(getSecretOrNull('ANTHROPIC_API_KEY')),
    codexCli: commandExists('codex'),
    openaiApi: Boolean(getSecretOrNull('OPENAI_API_KEY')),
  };
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

  if (available.claudeCli) {
    return {
      preferred: 'auto',
      selected: 'claude-cli',
      available,
      capabilities: { webSearch: true, cliRateLimits: true },
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

  if (available.codexCli) {
    return {
      preferred: 'auto',
      selected: 'codex-cli',
      available,
      capabilities: { webSearch: false, cliRateLimits: false },
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
  return /credit balance is too low|RATE_LIMITED|rate limit|429|529|overloaded/i.test(message);
}

export function shouldFallbackFromAnthropicToOpenAi(error: unknown): boolean {
  const message = errorMessage(error);
  return /credit balance is too low|insufficient|rate limit|429|529|overloaded|401|403|unauthorized/i.test(message);
}

export function shouldFallbackFromCodexCli(error: unknown): boolean {
  const message = errorMessage(error);
  return /rate limit|429|403|401|unauthorized|login|quota|billing|credit|usage limit|insufficient/i.test(message);
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
): Promise<ModelCallResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model', MODEL_ALIASES[model] ?? model,
      '--output-format', 'json',
      '--no-session-persistence',
    ];

    const fullPrompt = buildPrompt(prompt, systemPrompt);

    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true,
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude CLI timed out after 15 minutes'));
    }, 15 * 60 * 1000);

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
  _model: string,
  systemPrompt?: string,
): Promise<ModelCallResult> {
  return new Promise((resolve, reject) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'organism-model-codex-'));
    const outputFile = join(tempDir, 'last-message.txt');
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--ephemeral',
      '-o', outputFile,
      '-',
    ];

    const child = spawn('codex', args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true,
      env: { ...process.env },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('codex CLI timed out after 15 minutes'));
    }, 15 * 60 * 1000);

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
  const MODEL_IDS: Record<string, string> = {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-6',
  };

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const apiKey = getSecretOrNull('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('Selected model backend "anthropic-api" requires ANTHROPIC_API_KEY');
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL_IDS[model] ?? model,
    max_tokens: maxTokens,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
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
  model: string,
  systemPrompt?: string,
  maxTokens = 8192,
): Promise<ModelCallResult> {
  const apiKey = getSecretOrNull('OPENAI_API_KEY');
  if (!apiKey) {
    throw new Error('Selected model backend "openai-api" requires OPENAI_API_KEY');
  }

  const reasoningEffort = model === 'haiku' ? 'low' : model === 'sonnet' ? 'medium' : 'high';
  const configuredModel = process.env.ORGANISM_OPENAI_FALLBACK_MODEL
    ?? (model === 'haiku' ? process.env.ORGANISM_OPENAI_SMALL_MODEL : null)
    ?? 'gpt-5.4';

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: configuredModel,
      max_completion_tokens: maxTokens,
      reasoning_effort: reasoningEffort,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  });

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
    'claude-cli',
    'anthropic-api',
    'codex-cli',
    'openai-api',
  ];

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
  model: 'haiku' | 'sonnet' | 'opus',
  systemPrompt: string | undefined,
  maxTokens: number,
): Promise<ModelCallResult> {
  switch (backend) {
    case 'claude-cli':
      return callClaude(prompt, model, systemPrompt);
    case 'anthropic-api':
      return callApiDirect(prompt, model, systemPrompt, maxTokens);
    case 'codex-cli':
      return callCodexCli(prompt, model, systemPrompt);
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
  model: 'haiku' | 'sonnet' | 'opus',
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
      return await callBackend(candidate, prompt, model, systemPrompt, maxTokens);
    } catch (error) {
      lastError = error;
      const next = candidates[index + 1];
      if (!next || !shouldTryNextBackend(candidate, error)) {
        throw error;
      }
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
