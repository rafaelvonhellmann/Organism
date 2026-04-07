/**
 * Project Onboarding — structured interview to understand a new project.
 * Produces VISION.md (constitutional document) and config.json (auto-config).
 *
 * Inspired by Paperclip Vision's structured interview and Cabinet's 5-question onboarding.
 */

import * as fs from 'fs';
import * as path from 'path';
import { askMultiple, Clarification } from './clarify.js';
import { callModelUltra } from '../../../agents/_base/mcp-client.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge', 'projects');
const VAULT_ROOT = process.env.OBSIDIAN_VAULT_ROOT ?? "C:/Users/rafae/OneDrive/Documents/Rafael's Vault";

interface OnboardingResult {
  projectId: string;
  visionPath: string;
  configPath: string;
  vaultVisionPath: string;
  answers: Clarification[];
}

const ONBOARDING_QUESTIONS = [
  { question: 'What does this project do? (one sentence)', context: 'Core description' },
  { question: 'Who is the target user?', context: 'User persona' },
  { question: 'What tech stack is it built on?', context: 'e.g. Next.js, Python, Supabase...' },
  { question: 'What exists already? (codebase, docs, deployed, nothing?)', context: 'Current state' },
  { question: 'What are the top 3 priorities right now?', context: 'Comma-separated' },
  { question: 'What keeps you up at night about this project? (risks)', context: 'Biggest worries' },
  { question: 'Who are the competitors or similar products?', context: 'Names or URLs' },
  { question: 'What is the revenue/business model?', context: 'e.g. SaaS, freemium, philanthropic, none yet' },
  { question: 'What quality standards apply? (medical, research, general)', context: 'Affects risk classification' },
  { question: 'What is the 30-day goal? And the 90-day goal?', context: 'Concrete milestones' },
];

/**
 * Run the full onboarding interview for a new project.
 */
export async function onboardProject(projectId: string, projectPath?: string): Promise<OnboardingResult> {
  console.log(`\n  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║   O R G A N I S M   O N B O A R D I N G     ║`);
  console.log(`  ╚══════════════════════════════════════════════╝`);
  console.log(`\n  Project: ${projectId}`);
  if (projectPath) console.log(`  Path: ${projectPath}`);
  console.log(`\n  I'll ask you ${ONBOARDING_QUESTIONS.length} questions to understand this project.\n`);

  // 1. Conduct interview
  const answers = await askMultiple(ONBOARDING_QUESTIONS);

  console.log('\n  Interview complete. Generating VISION.md and config...\n');

  // 2. Build Q&A context for LLM
  const qaText = answers
    .map((a, i) => `Q${i + 1}: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');

  // 3. Generate VISION.md via LLM
  const visionPrompt = `Based on the following interview with the project founder, generate a VISION.md constitutional document for the project "${projectId}".

Interview:
${qaText}

Generate the document with these sections:
1. Mission — what the project does and explicitly does NOT do
2. Target Users — primary and secondary segments
3. Current State — honest assessment of where things are
4. Priorities — the top priorities from the interview
5. Risks — what keeps the founder up at night
6. Competitive Landscape — competitors and differentiation
7. Business Model — how it makes money (or plans to)
8. Quality Standards — what level of rigor is required
9. Success Metrics — 30-day and 90-day concrete milestones
10. Guiding Principles — 3-5 operating principles derived from the interview

Format as clean markdown. No preamble. Start with "# VISION — {project name}".`;

  const visionResult = await callModelUltra(visionPrompt, 'sonnet');

  // 4. Generate config.json via LLM
  const configPrompt = `Based on this interview, generate a JSON config for the project "${projectId}".

Interview:
${qaText}

Generate valid JSON matching this structure exactly:
{
  "id": "${projectId}",
  "name": "<proper name from interview>",
  "phase": "<BUILD or OPERATE or GROW>",
  "description": "<one sentence from Q1>",
  "techStack": [<from Q3, array of strings>],
  "qualityStandards": [<from Q9, e.g. "MEDICAL" or "GENERAL">],
  "riskOverrides": {
    "keywords": [<domain-specific risky keywords>],
    "defaultLane": null
  },
  "perspectives": {
    "recommended": [<perspective IDs most relevant from: strategy, technology, financial, product, engineering, infrastructure, marketing, seo, communications, legal-compliance, security, analytics, medical-content, growth>],
    "skip": [<perspective IDs irrelevant for this project>]
  },
  "competitors": [<from Q7>],
  "path": ${projectPath ? `"${projectPath.replace(/\\/g, '/')}"` : 'null'}
}

Return ONLY valid JSON. No markdown fences. No explanation.`;

  const configResult = await callModelUltra(configPrompt, 'sonnet');

  // 5. Write files
  const projectDir = path.join(KNOWLEDGE_DIR, projectId);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  const visionPath = path.join(projectDir, 'VISION.md');
  fs.writeFileSync(visionPath, visionResult.text, 'utf8');

  const configPath = path.join(projectDir, 'config.json');
  // Try to parse and re-format the JSON, fall back to raw text
  try {
    const parsed = JSON.parse(configResult.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
  } catch {
    fs.writeFileSync(configPath, configResult.text, 'utf8');
  }

  // 6. Write VISION.md to Obsidian vault
  const vaultVisionDir = path.join(VAULT_ROOT, 'Organism', 'VISION');
  if (!fs.existsSync(vaultVisionDir)) {
    fs.mkdirSync(vaultVisionDir, { recursive: true });
  }
  const vaultVisionPath = path.join(vaultVisionDir, `${projectId}-vision.md`);
  const vaultContent = `---
project: ${projectId}
type: vision
date: ${new Date().toISOString().slice(0, 10)}
tags: [organism, vision, ${projectId}]
---

${visionResult.text}
`;
  fs.writeFileSync(vaultVisionPath, vaultContent, 'utf8');

  console.log(`  VISION.md written to: ${visionPath}`);
  console.log(`  config.json written to: ${configPath}`);
  console.log(`  Obsidian vault: ${vaultVisionPath}\n`);

  return {
    projectId,
    visionPath,
    configPath,
    vaultVisionPath,
    answers,
  };
}
