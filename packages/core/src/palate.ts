import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getCapabilitiesForProject, loadRegistry } from './registry.js';
import { writeAudit } from './audit.js';
import { assertBudget, recordSpend, estimateCost } from './budget.js';
import { callModel } from '../../../agents/_base/mcp-client.js';
import { AgentCapability } from '../../shared/src/types.js';
import { getApprovedSourcesByTags, recordSourceInjection } from './palate-sources.js';
import { STATE_DIR } from '../../shared/src/state-dir.js';

// Palate: capability-scoped knowledge injection with distillation + caching.

export interface SourceInjection {
  capabilityId: string;
  sourcePaths: string[];
  totalBytes: number;
  estimatedTokens: number;
}

/**
 * Resolve which knowledgeSources apply to a task, scoped by capability + project.
 * Uses the same matching logic as registry.resolveOwner, but returns
 * the matched capability's knowledgeSources rather than the agent name.
 *
 * If multiple capabilities match, returns the union of their sources (deduplicated).
 * If no capability matches or none have knowledgeSources, returns null.
 */
export function resolveTaskSources(
  taskDescription: string,
  projectId?: string,
): SourceInjection | null {
  const registry = projectId
    ? getCapabilitiesForProject(projectId)
    : loadRegistry().filter((c) => c.status === 'active');

  const lower = taskDescription.toLowerCase();

  const matches = registry.filter((cap) => {
    // Match by capability ID (dots → spaces): "marketing.strategy" → "marketing strategy"
    if (lower.includes(cap.id.replace(/\./g, ' '))) return true;
    // Match by individual ID segments: "marketing.strategy" → check if "marketing" OR "strategy" appears
    // Only segments > 5 chars to avoid false positives on short generic words
    const idSegments = cap.id.split('.');
    if (idSegments.some((seg) => seg.length > 5 && lower.includes(seg))) return true;
    // Match by agent owner name
    if (lower.includes(cap.owner)) return true;
    // Match by significant words in description (strip punctuation for clean matching)
    const descWords = cap.description.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
    return descWords.some((w) => w.length > 4 && lower.includes(w));
  });

  if (matches.length === 0) return null;

  // Collect all knowledgeSources from matching capabilities, deduplicated
  const sourceSet = new Set<string>();
  let matchedCapId = '';
  for (const cap of matches) {
    if (cap.knowledgeSources) {
      for (const src of cap.knowledgeSources) sourceSet.add(src);
      if (!matchedCapId) matchedCapId = cap.id;
    }
  }

  // Also check the Palate source registry for approved sources matching capability tags
  try {
    const capTags = matches.flatMap((c) => c.id.split('.'));
    const registrySources = getApprovedSourcesByTags(capTags, projectId);
    for (const rs of registrySources) {
      sourceSet.add(rs.localPath);
    }
  } catch { /* source registry not yet initialized — safe to skip */ }

  if (sourceSet.size === 0) return null;

  // If multiple capabilities matched, join their IDs for traceability
  if (matches.filter((c) => c.knowledgeSources?.length).length > 1) {
    matchedCapId = matches
      .filter((c) => c.knowledgeSources?.length)
      .map((c) => c.id)
      .join('+');
  }

  const sourcePaths = [...sourceSet];
  const root = process.cwd();
  let totalBytes = 0;

  for (const sp of sourcePaths) {
    const abs = path.resolve(root, sp);
    try {
      const stat = fs.statSync(abs);
      totalBytes += stat.size;
    } catch {
      // File missing — will be handled in loadSources
    }
  }

  // Rough estimate: 1 token ~ 4 bytes for English markdown
  const estimatedTokens = Math.ceil(totalBytes / 4);

  return { capabilityId: matchedCapId, sourcePaths, totalBytes, estimatedTokens };
}

// ── Distillation + Cache ──────────────────────────────────────────────────

const CACHE_DIR = path.join(STATE_DIR, 'palate-cache');
const DISTILL_PROMPT_VERSION = 1;
const DISTILL_MODEL = 'haiku' as const;

const DISTILL_SYSTEM = `You are a knowledge distiller. Compress the provided document to ~30% of its length while preserving all actionable frameworks, decision criteria, metrics, and concrete examples. Output markdown. No preamble.`;

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(content: string): string {
  return crypto.createHash('sha256')
    .update(content + '::v' + DISTILL_PROMPT_VERSION + '::' + DISTILL_MODEL)
    .digest('hex');
}

function getCachePath(hash: string): string {
  return path.join(CACHE_DIR, `${hash}.md`);
}

/**
 * Distill a source file to ~30% of its tokens via Haiku.
 * Cache key: SHA-256(fileContent + DISTILL_PROMPT_VERSION + model).
 * Returns cached result on hit, calls Haiku on miss.
 */
export async function distillSource(
  sourcePath: string,
  content: string,
): Promise<{ text: string; fromCache: boolean; inputTokens: number; outputTokens: number }> {
  ensureCacheDir();
  const hash = cacheKey(content);
  const cachePath = getCachePath(hash);

  if (fs.existsSync(cachePath)) {
    return { text: fs.readFileSync(cachePath, 'utf8'), fromCache: true, inputTokens: 0, outputTokens: 0 };
  }

  const prompt = `Distill this document:\n\n---\n${content}\n---`;
  const result = await callModel(prompt, DISTILL_MODEL, DISTILL_SYSTEM);

  fs.writeFileSync(cachePath, result.text, 'utf8');
  return { text: result.text, fromCache: false, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

/**
 * Like loadSources but returns distilled versions.
 * Falls back to raw content if distillation fails.
 * Tracks budget under 'palate-distiller'.
 */
export async function loadDistilledSources(
  injection: SourceInjection,
  taskId: string,
  agentName: string,
): Promise<Record<string, string>> {
  const root = process.cwd();
  const sources: Record<string, string> = {};
  let loadedBytes = 0;
  let distilledBytes = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const sp of injection.sourcePaths) {
    const abs = path.resolve(root, sp);
    let rawContent: string;
    try {
      rawContent = fs.readFileSync(abs, 'utf8');
    } catch {
      console.warn(`[palate] Source not found: ${abs}`);
      continue;
    }

    loadedBytes += Buffer.byteLength(rawContent, 'utf8');

    try {
      assertBudget('palate-distiller', 0.01);
      const distilled = await distillSource(sp, rawContent);
      sources[sp] = distilled.text;
      distilledBytes += Buffer.byteLength(distilled.text, 'utf8');

      if (distilled.fromCache) {
        cacheHits++;
      } else {
        cacheMisses++;
        totalInputTokens += distilled.inputTokens;
        totalOutputTokens += distilled.outputTokens;
        const cost = estimateCost(DISTILL_MODEL, distilled.inputTokens, distilled.outputTokens);
        recordSpend('palate-distiller', distilled.inputTokens, distilled.outputTokens, cost, 'organism');
      }
    } catch (err) {
      // Budget exceeded or distillation failed — fall back to raw
      console.warn(`[palate] Distillation failed for ${sp}, using raw: ${(err as Error).message}`);
      sources[sp] = rawContent;
      distilledBytes += Buffer.byteLength(rawContent, 'utf8');
    }
  }

  const rawTokens = Math.ceil(loadedBytes / 4);
  const distilledTokens = Math.ceil(distilledBytes / 4);

  writeAudit({
    agent: agentName,
    taskId,
    action: 'source_injection',
    payload: {
      capabilityId: injection.capabilityId,
      sourcePaths: injection.sourcePaths,
      loadedPaths: Object.keys(sources),
      rawBytes: loadedBytes,
      rawTokens,
      distilledBytes,
      distilledTokens,
      tokenSavings: rawTokens - distilledTokens,
      cacheHits,
      cacheMisses,
      distillCost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    },
    outcome: Object.keys(sources).length > 0 ? 'success' : 'failure',
  });

  // Record per-source injection for Darwinian fitness tracking
  for (const sp of Object.keys(sources)) {
    const sourceId = path.basename(sp, path.extname(sp));
    try { recordSourceInjection(sourceId); } catch { /* table may not exist yet */ }
  }

  return sources;
}
