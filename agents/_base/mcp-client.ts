/**
 * MCP Client — routes all agent LLM calls through the `claude` CLI.
 *
 * Uses `claude -p` (print mode) instead of the Anthropic SDK directly.
 * This means agent calls go through the user's Claude Code subscription
 * rather than burning prepaid API credits.
 *
 * Fallback: set USE_API_DIRECT=true to use the Anthropic SDK with
 * ANTHROPIC_API_KEY instead (for CI or headless environments).
 */

import { spawn } from 'child_process';
import { getSecretOrNull } from '../../packages/shared/src/secrets.js';

const MODEL_ALIASES: Record<string, string> = {
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
};

// ── Rate limit tracking ───────────────────────────────────────────────────
// When Claude CLI returns "You've hit your limit", we parse the reset time
// and pause all agent work until the limit resets.

let _rateLimitResetAt: number | null = null;
let _rateLimitUsagePct: number = 0;
let _sessionCostUsd: number = 0;
const COST_LIMIT_ESTIMATE = 50.0; // Rough estimate — adjust based on plan

export function isRateLimited(): boolean {
  if (!_rateLimitResetAt) return false;
  if (Date.now() >= _rateLimitResetAt) {
    _rateLimitResetAt = null; // Reset expired, clear the flag
    return false;
  }
  return true;
}

export function getRateLimitStatus(): { limited: boolean; resetsAt: number | null; usagePct: number; sessionCost: number } {
  return {
    limited: isRateLimited(),
    resetsAt: _rateLimitResetAt,
    usagePct: _rateLimitUsagePct,
    sessionCost: _sessionCostUsd,
  };
}

function parseResetTime(errorMsg: string): number | null {
  // Pattern: "resets 10pm (Australia/Sydney)" or "resets 2am"
  const match = errorMsg.match(/resets?\s+(\d{1,2})(am|pm)\s*\(?([\w/]+)?\)?/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const ampm = match[2].toLowerCase();
  const tz = match[3] || 'Australia/Sydney';

  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  // Build a target time in the specified timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', hour12: false });
  const currentHourInTz = parseInt(formatter.format(now), 10);

  // Calculate ms until reset
  let hoursUntilReset = hour - currentHourInTz;
  if (hoursUntilReset <= 0) hoursUntilReset += 24;

  return Date.now() + hoursUntilReset * 60 * 60 * 1000;
}

function checkForRateLimit(errorMsg: string): boolean {
  if (errorMsg.includes("hit your limit") || errorMsg.includes("rate limit")) {
    const resetAt = parseResetTime(errorMsg);
    if (resetAt) {
      _rateLimitResetAt = resetAt;
      const resetDate = new Date(resetAt);
      console.log(`[RateLimit] Hit limit. Auto-resume at ${resetDate.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}`);
    } else {
      // Can't parse time — default to 1 hour from now
      _rateLimitResetAt = Date.now() + 60 * 60 * 1000;
      console.log(`[RateLimit] Hit limit. Cannot parse reset time — retrying in 1 hour.`);
    }
    _rateLimitUsagePct = 100;
    return true;
  }
  return false;
}

function trackCost(costUsd: number): void {
  _sessionCostUsd += costUsd;
  _rateLimitUsagePct = Math.min(100, (_sessionCostUsd / COST_LIMIT_ESTIMATE) * 100);
  if (_rateLimitUsagePct >= 95) {
    console.warn(`[RateLimit] Session cost $${_sessionCostUsd.toFixed(2)} — estimated ${_rateLimitUsagePct.toFixed(0)}% of limit. Approaching cap.`);
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
  duration_ms?: number;
}

/**
 * Call the claude CLI in print mode. Returns parsed result.
 * Uses spawn (not execFile) for reliable cross-platform behaviour.
 */
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

    // Embed system prompt in the user message to avoid shell escaping issues.
    // With shell:true (needed on Windows for .cmd resolution), --system-prompt
    // arguments with quotes/special chars get mangled.
    //
    // Known overhead: ~2-5% extra tokens from embedding system prompt in user
    // message vs. using a dedicated --system-prompt flag. This is acceptable
    // because: (1) Windows shell escaping makes --system-prompt unreliable,
    // (2) each CLI call is a fresh process so cross-call caching is impossible,
    // (3) the token overhead is small relative to the context payload.
    // If Claude CLI adds --system-prompt-file in future, switch to that.
    const fullPrompt = systemPrompt
      ? `<system-instructions>\n${systemPrompt}\n</system-instructions>\n\n${prompt}`
      : prompt;

    // On Windows, spawn needs shell:true to resolve .cmd shims in PATH
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true,
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => errChunks.push(d));

    // 15 minute timeout (complex analyses need time)
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude CLI timed out after 15 minutes'));
    }, 15 * 60 * 1000);

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

        // Track cost from this call
        if (data.modelUsage) {
          for (const m of Object.values(data.modelUsage)) {
            if ((m as Record<string, unknown>).costUSD) trackCost((m as Record<string, unknown>).costUSD as number);
          }
        }

        let inputTokens = 0;
        let outputTokens = 0;

        if (data.modelUsage) {
          for (const m of Object.values(data.modelUsage)) {
            inputTokens += (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
            outputTokens += m.outputTokens ?? 0;
          }
        } else if (data.usage) {
          inputTokens = (data.usage.input_tokens ?? 0) +
            (data.usage.cache_creation_input_tokens ?? 0) +
            (data.usage.cache_read_input_tokens ?? 0);
          outputTokens = data.usage.output_tokens ?? 0;
        }

        resolve({
          text: data.result ?? '',
          inputTokens,
          outputTokens,
        });
      } catch {
        // If JSON parse fails, treat raw stdout as the text response
        resolve({
          text: stdout.trim(),
          inputTokens: 0,
          outputTokens: 0,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI spawn error: ${err.message}`));
    });

    // Send prompt via stdin
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

// ── Direct API fallback (for CI / headless) ────────────────────────────────

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
  if (!apiKey) throw new Error('USE_API_DIRECT=true but ANTHROPIC_API_KEY not set');

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL_IDS[model] ?? model,
    max_tokens: maxTokens,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// ── Public API (unchanged signatures — drop-in replacement) ────────────────

function shouldUseApiDirect(): boolean {
  return process.env.USE_API_DIRECT === 'true';
}

export async function callModel(
  prompt: string,
  model: 'haiku' | 'sonnet' | 'opus',
  systemPrompt?: string,
): Promise<ModelCallResult> {
  if (shouldUseApiDirect()) return callApiDirect(prompt, model, systemPrompt, 2048);
  return callClaude(prompt, model, systemPrompt);
}

export async function callModelLong(
  prompt: string,
  model: 'haiku' | 'sonnet' | 'opus',
  systemPrompt?: string,
  _maxTokens = 4096,
): Promise<ModelCallResult> {
  if (shouldUseApiDirect()) return callApiDirect(prompt, model, systemPrompt, _maxTokens);
  return callClaude(prompt, model, systemPrompt);
}

export async function callModelUltra(
  prompt: string,
  model: 'haiku' | 'sonnet' | 'opus',
  systemPrompt?: string,
): Promise<ModelCallResult> {
  if (shouldUseApiDirect()) return callApiDirect(prompt, model, systemPrompt, 8192);
  return callClaude(prompt, model, systemPrompt);
}
