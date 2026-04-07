/**
 * Knowledge Distillation — condenses accumulated review knowledge
 * into a compact summary per project. Reduces token usage over time
 * as the distilled context replaces raw review outputs.
 *
 * Inspired by Icarus's "cost decreases as vault grows" principle.
 */

import * as fs from 'fs';
import * as path from 'path';
import { callModelUltra } from '../../../agents/_base/mcp-client.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge', 'projects');
const VAULT_ROOT = process.env.OBSIDIAN_VAULT_ROOT ?? "C:/Users/rafae/OneDrive/Documents/Rafael's Vault";

export interface DistillationResult {
  projectId: string;
  distilledPath: string;
  vaultPath: string;
  sourceCount: number;
  inputChars: number;
  outputChars: number;
}

/**
 * Load the existing distilled knowledge for a project (if any).
 */
export function loadDistilled(projectId: string): string | null {
  const filePath = path.join(KNOWLEDGE_DIR, projectId, 'distilled.md');
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Collect all review outputs from the Obsidian vault for a project.
 */
function collectReviewOutputs(projectId: string): string[] {
  const reviewDir = path.join(VAULT_ROOT, 'Organism', 'Reviews', projectId);
  if (!fs.existsSync(reviewDir)) return [];

  return fs.readdirSync(reviewDir)
    .filter(f => f.endsWith('.md') && !f.includes('review-index'))
    .sort() // chronological (date prefix)
    .map(f => fs.readFileSync(path.join(reviewDir, f), 'utf8'));
}

/**
 * Collect all research outputs for a project.
 */
function collectResearchOutputs(projectId: string): string[] {
  const researchDir = path.join(KNOWLEDGE_DIR, projectId, 'research');
  if (!fs.existsSync(researchDir)) return [];

  return fs.readdirSync(researchDir)
    .filter(f => f.endsWith('.md'))
    .map(f => fs.readFileSync(path.join(researchDir, f), 'utf8'));
}

/**
 * Distill all accumulated knowledge about a project into a single document.
 * This runs an LLM pass over all reviews + research to extract:
 * - Key decisions made
 * - Recurring themes
 * - Unresolved risks
 * - Architecture/technical summary
 * - Strategic direction
 */
export async function distillProject(projectId: string): Promise<DistillationResult> {
  console.log(`\n  [Distill] Collecting knowledge for ${projectId}...`);

  const reviews = collectReviewOutputs(projectId);
  const research = collectResearchOutputs(projectId);
  const vision = (() => {
    const visionPath = path.join(KNOWLEDGE_DIR, projectId, 'VISION.md');
    return fs.existsSync(visionPath) ? fs.readFileSync(visionPath, 'utf8') : '';
  })();
  const existing = loadDistilled(projectId);

  const allSources = [...reviews, ...research];
  if (allSources.length === 0 && !vision) {
    console.log('  [Distill] No review or research data found. Run some reviews first.');
    return {
      projectId,
      distilledPath: '',
      vaultPath: '',
      sourceCount: 0,
      inputChars: 0,
      outputChars: 0,
    };
  }

  const sourceText = allSources.join('\n\n---\n\n');
  const inputChars = sourceText.length + vision.length;
  console.log(`  [Distill] Found ${reviews.length} reviews, ${research.length} research docs (${(inputChars / 1000).toFixed(0)}k chars)`);

  const prompt = `You are distilling accumulated knowledge about the project "${projectId}" into a single authoritative reference document.

${vision ? `## Project Vision\n${vision}\n\n` : ''}
${existing ? `## Previous Distillation (update and extend this)\n${existing}\n\n` : ''}
## All Review & Research Outputs
${sourceText}

---

Produce a distilled knowledge document with these sections:

1. **Project Summary** — What this project is, in 2-3 sentences
2. **Current State** — Where things stand right now (deployed? prototype? production?)
3. **Architecture** — Tech stack, key components, deployment topology
4. **Key Decisions** — Important decisions that have been made and why
5. **Recurring Themes** — Issues or patterns that appear across multiple reviews
6. **Unresolved Risks** — Open problems that haven't been addressed yet
7. **Strengths** — What's working well (don't just list problems)
8. **Strategic Direction** — Where the project should go next
9. **Action Items** — Top 5 most impactful things to do next, in priority order

Rules:
- Be factual. Reference specific files, APIs, or features.
- Synthesize across reviews — don't just list each review's findings.
- If multiple reviews say the same thing, consolidate into one point.
- If reviews contradict, note the disagreement.
- This document will be used as context for future reviews, so be precise.
- Maximum 2000 words.`;

  console.log('  [Distill] Generating distillation...');
  const result = await callModelUltra(prompt, 'sonnet');
  const outputChars = result.text.length;

  const date = new Date().toISOString().slice(0, 10);

  // Write to knowledge directory
  const distilledPath = path.join(KNOWLEDGE_DIR, projectId, 'distilled.md');
  const dirPath = path.dirname(distilledPath);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

  const frontmatter = `---
project: ${projectId}
type: distillation
date: ${date}
sources: ${allSources.length}
input_chars: ${inputChars}
tags: [organism, distillation, ${projectId}]
---

`;
  fs.writeFileSync(distilledPath, frontmatter + result.text, 'utf8');

  // Write to Obsidian vault
  const vaultDir = path.join(VAULT_ROOT, 'Organism', 'Distilled');
  if (!fs.existsSync(vaultDir)) fs.mkdirSync(vaultDir, { recursive: true });
  const vaultPath = path.join(vaultDir, `${projectId}-distilled.md`);
  fs.writeFileSync(vaultPath, frontmatter + result.text, 'utf8');

  console.log(`  [Distill] Done. ${(inputChars / 1000).toFixed(0)}k chars → ${(outputChars / 1000).toFixed(0)}k chars (${((1 - outputChars / inputChars) * 100).toFixed(0)}% compression)`);
  console.log(`  [Distill] Knowledge: ${distilledPath}`);
  console.log(`  [Distill] Vault: ${vaultPath}\n`);

  return { projectId, distilledPath, vaultPath, sourceCount: allSources.length, inputChars, outputChars };
}
