/**
 * MCP Client — Week 1 uses direct Anthropic SDK calls.
 * When PRAISON_SIDECAR_URL is set, traffic routes through the PraisonAI sidecar instead.
 *
 * Why this abstraction: keeps all agents ignorant of whether the sidecar is live.
 * Swap the implementation here, all agents benefit automatically.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSecret } from '../../packages/shared/src/secrets.js';

const MODEL_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

export interface ModelCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = getSecret('ANTHROPIC_API_KEY');
  _client = new Anthropic({ apiKey });
  return _client;
}

export async function callModel(
  prompt: string,
  model: 'haiku' | 'sonnet' | 'opus',
  systemPrompt?: string
): Promise<ModelCallResult> {
  const client = getClient();
  const modelId = MODEL_IDS[model];

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 2048,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// Convenience: call with a higher token budget for longer outputs (e.g., PRDs, reviews)
export async function callModelLong(
  prompt: string,
  model: 'haiku' | 'sonnet' | 'opus',
  systemPrompt?: string,
  maxTokens = 4096
): Promise<ModelCallResult> {
  const client = getClient();
  const modelId = MODEL_IDS[model];

  const response = await client.messages.create({
    model: modelId,
    max_tokens: maxTokens,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// Ultra: 8192 tokens for deep investigation / ultrathink analysis
export async function callModelUltra(
  prompt: string,
  model: 'haiku' | 'sonnet' | 'opus',
  systemPrompt?: string
): Promise<ModelCallResult> {
  const client = getClient();
  const modelId = MODEL_IDS[model];

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 8192,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
