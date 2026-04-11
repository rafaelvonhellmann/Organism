/**
 * Research — internet research before perspectives form opinions.
 * Uses the selected model backend's web-search capability to gather
 * competitor intel, market context, and technical documentation.
 *
 * Results are cached as markdown in knowledge/projects/{id}/research/
 * and mirrored to the Obsidian vault at Organism/Research/{project}/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { callModelUltra, resolveModelBackend } from '../../../agents/_base/mcp-client.js';
import { runMiniMaxSearch } from './minimax.js';
import { loadProjectPolicy } from './project-policy.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge', 'projects');
const VAULT_ROOT = process.env.OBSIDIAN_VAULT_ROOT ?? "C:/Users/rafae/OneDrive/Documents/Rafael's Vault";

export interface ResearchResult {
  topic: string;
  projectId: string;
  content: string;
  cachedAt: number;
  filePath: string;
  vaultPath: string;
}

/**
 * Check if cached research exists and is fresh (default: 7 days).
 */
export function isResearchFresh(projectId: string, topic: string, maxAgeDays = 7): boolean {
  const filePath = getResearchPath(projectId, topic);
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
  return ageDays < maxAgeDays;
}

/**
 * Load cached research if it exists.
 */
export function loadCachedResearch(projectId: string, topic: string): string | null {
  const filePath = getResearchPath(projectId, topic);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Load ALL cached research for a project (all topics).
 */
export function loadAllResearch(projectId: string): string {
  const dir = path.join(KNOWLEDGE_DIR, projectId, 'research');
  if (!fs.existsSync(dir)) return '';
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  return files.map(f => {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    return `## ${f.replace('.md', '').replace(/-/g, ' ')}\n\n${content}`;
  }).join('\n\n---\n\n');
}

function getResearchPath(projectId: string, topic: string): string {
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
  return path.join(KNOWLEDGE_DIR, projectId, 'research', `${slug}.md`);
}

function getVaultResearchPath(projectId: string, topic: string): string {
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
  return path.join(VAULT_ROOT, 'Organism', 'Research', projectId, `${slug}.md`);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Research a topic for a project.
 * Results are cached as markdown files.
 */
export async function researchTopic(
  projectId: string,
  topic: string,
  context?: string,
): Promise<ResearchResult> {
  // Check cache first
  if (isResearchFresh(projectId, topic)) {
    const cached = loadCachedResearch(projectId, topic)!;
    const filePath = getResearchPath(projectId, topic);
    const vaultPath = getVaultResearchPath(projectId, topic);
    console.log(`  [Research] Cache hit: ${topic} (< 7 days old)`);
    return { topic, projectId, content: cached, cachedAt: Date.now(), filePath, vaultPath };
  }

  const backend = resolveModelBackend();
  const policy = loadProjectPolicy(projectId);

  console.log(`  [Research] Searching: ${topic}...`);

  const sharedRequirements = `Topic: ${topic}
Project context: ${projectId}${context ? `\n\nAdditional context: ${context}` : ''}

Requirements:
- Include specific facts, numbers, URLs where available
- For competitors: pricing, features, user counts, funding, tech stack
- For market research: trends, size estimates, key players
- For technical research: documentation links, best practices, common patterns
- Cite your sources with URLs
- Structure the output with clear headers
- Be factual, not speculative
- Maximum 1500 words`;

  let result;
  if (backend.capabilities.webSearch) {
    const prompt = `Research the following topic thoroughly using web search. Find current, factual information.

${sharedRequirements}

- Search the web for up-to-date information`;
    result = await callModelUltra(prompt, 'sonnet');
  } else {
    const search = runMiniMaxSearch(policy, `${projectId}: ${topic}${context ? ` ${context}` : ''}`);
    const prompt = `You are writing a structured research memo using search results that were already collected by a bounded external search tool.

${sharedRequirements}

Search results:
${search.summary}

Raw search payload:
${typeof search.structured === 'string' ? search.structured : JSON.stringify(search.structured, null, 2)}
`;
    result = await callModelUltra(prompt, 'sonnet');
  }

  const date = new Date().toISOString().slice(0, 10);
  const frontmatter = `---
project: ${projectId}
topic: ${topic}
date: ${date}
type: research
tags: [organism, research, ${projectId}]
---

`;

  const content = frontmatter + result.text;

  // Write to knowledge directory
  const filePath = getResearchPath(projectId, topic);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');

  // Mirror to Obsidian vault
  const vaultPath = getVaultResearchPath(projectId, topic);
  ensureDir(path.dirname(vaultPath));
  fs.writeFileSync(vaultPath, content, 'utf8');

  console.log(`  [Research] Done: ${topic}`);

  return { topic, projectId, content: result.text, cachedAt: Date.now(), filePath, vaultPath };
}

/**
 * Run competitor research for a project.
 */
export async function researchCompetitors(
  projectId: string,
  competitors: string[],
  projectDescription?: string,
): Promise<ResearchResult> {
  const competitorList = competitors.join(', ');
  return researchTopic(
    projectId,
    'competitors',
    `Competitors to analyse: ${competitorList}. Project description: ${projectDescription ?? projectId}. Build a comparison matrix.`,
  );
}

/**
 * Run market research for a project.
 */
export async function researchMarket(
  projectId: string,
  projectDescription?: string,
): Promise<ResearchResult> {
  return researchTopic(
    projectId,
    'market-landscape',
    `Market landscape analysis for: ${projectDescription ?? projectId}. Include market size, trends, key players, and opportunities.`,
  );
}
