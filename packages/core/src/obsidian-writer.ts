/**
 * Obsidian Vault Writer — writes perspective review outputs as linked markdown
 * files with YAML frontmatter compatible with Dataview.
 *
 * Atomic writes (.tmp → rename) for OneDrive safety.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PerspectiveResult, PerspectiveReviewResult } from '../../shared/src/types.js';

const VAULT_ROOT = process.env.OBSIDIAN_VAULT_PATH ?? "C:/Users/rafae/OneDrive/Documents/Rafael's Vault";
const ORGANISM_DIR = path.join(VAULT_ROOT, 'Organism');
const REVIEWS_DIR = path.join(ORGANISM_DIR, 'Reviews');
const DAILY_DIR = path.join(ORGANISM_DIR, 'Daily');

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Write to .tmp then rename — atomic for OneDrive sync safety. */
function atomicWrite(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function buildFrontmatter(fields: Record<string, string | number | string[]>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function perspectiveFileName(date: string, perspectiveId: string): string {
  return `${date}-${perspectiveId}.md`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Write a single perspective review output to the vault.
 */
export function writeReviewToVault(
  result: PerspectiveResult,
  projectId: string,
  siblingPerspectives: string[],
): string {
  const date = todayStr();
  const projectDir = path.join(REVIEWS_DIR, projectId);
  const fileName = perspectiveFileName(date, result.perspectiveId);
  const filePath = path.join(projectDir, fileName);

  const frontmatter = buildFrontmatter({
    project: projectId,
    perspective: result.perspectiveId,
    domain: result.domain,
    date,
    cost_usd: result.costUsd,
    tags: ['organism', 'review', result.perspectiveId, projectId],
  });

  // Build wikilinks to sibling perspectives from same session
  const siblings = siblingPerspectives
    .filter(id => id !== result.perspectiveId)
    .map(id => `- [[${date}-${id}]]`)
    .join('\n');

  const siblingSection = siblings
    ? `\n## Related perspectives\n\n${siblings}\n`
    : '';

  const content = `${frontmatter}\n\n# ${result.domain} Review — ${projectId}\n\n${result.text}\n${siblingSection}\n---\n*Duration: ${result.durationMs}ms | Tokens: ${result.inputTokens + result.outputTokens} | Cost: $${result.costUsd.toFixed(4)}*\n`;

  atomicWrite(filePath, content);
  return filePath;
}

/**
 * Write all perspectives from a review session + a combined index file.
 */
export function writeCombinedReviewToVault(result: PerspectiveReviewResult): string[] {
  const date = todayStr();
  const siblingIds = result.perspectives.map(p => p.perspectiveId);
  const writtenPaths: string[] = [];

  // Write individual perspective files
  for (const p of result.perspectives) {
    const filePath = writeReviewToVault(p, result.projectId, siblingIds);
    writtenPaths.push(filePath);
  }

  // Write index file
  const projectDir = path.join(REVIEWS_DIR, result.projectId);
  const indexPath = path.join(projectDir, `${date}-review-index.md`);

  const frontmatter = buildFrontmatter({
    project: result.projectId,
    perspective: 'index',
    domain: 'Review Index',
    date,
    cost_usd: result.totalCostUsd,
    tags: ['organism', 'review', 'index', result.projectId],
  });

  const perspectiveLinks = result.perspectives
    .map(p => `- [[${date}-${p.perspectiveId}|${p.domain}]] — $${p.costUsd.toFixed(4)}`)
    .join('\n');

  const content = `${frontmatter}\n\n# Review Index — ${result.projectId} (${date})\n\n**Scope:** ${result.scope}\n\n## Perspectives\n\n${perspectiveLinks}\n\n## Summary\n\n- **Total cost:** $${result.totalCostUsd.toFixed(4)}\n- **Total duration:** ${(result.totalDurationMs / 1000).toFixed(1)}s\n- **Perspectives run:** ${result.perspectives.length}\n`;

  atomicWrite(indexPath, content);
  writtenPaths.push(indexPath);

  return writtenPaths;
}

/**
 * Write a morning brief to the daily folder.
 */
export function writeMorningBriefToVault(content: string): string {
  const date = todayStr();
  const filePath = path.join(DAILY_DIR, `${date}-morning-brief.md`);

  const frontmatter = buildFrontmatter({
    date,
    type: 'morning-brief',
    tags: ['organism', 'daily', 'morning-brief'],
  });

  const fileContent = `${frontmatter}\n\n# Morning Brief — ${date}\n\n${content}\n`;

  atomicWrite(filePath, fileContent);
  return filePath;
}
