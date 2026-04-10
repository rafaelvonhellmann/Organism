import * as fs from 'fs';
import * as path from 'path';
import { RUNS_DIR } from '../../shared/src/state-dir.js';

const MEMORY_FILES = {
  progress: 'progress.md',
  checklist: 'feature_checklist.json',
  facts: 'facts.json',
  handoff: 'handoff.md',
  commands: 'command-log.jsonl',
  init: 'init.sh',
} as const;

export interface RunMemoryPaths {
  root: string;
  progress: string;
  checklist: string;
  facts: string;
  handoff: string;
  commands: string;
  init: string;
}

function mkdirp(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function defaultInitScript(projectId: string): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `echo "Initializing Organism run memory for ${projectId}"`,
    'test -f progress.md || printf "# Progress\\n\\n- Run initialized\\n" > progress.md',
    'test -f feature_checklist.json || printf "[]\\n" > feature_checklist.json',
    'test -f facts.json || printf "{}\\n" > facts.json',
    'test -f handoff.md || printf "# Handoff\\n\\nNo handoff recorded yet.\\n" > handoff.md',
    'touch command-log.jsonl',
    '',
  ].join('\n');
}

export function getRunMemoryPaths(goalId: string): RunMemoryPaths {
  const root = path.join(RUNS_DIR, goalId);
  return {
    root,
    progress: path.join(root, MEMORY_FILES.progress),
    checklist: path.join(root, MEMORY_FILES.checklist),
    facts: path.join(root, MEMORY_FILES.facts),
    handoff: path.join(root, MEMORY_FILES.handoff),
    commands: path.join(root, MEMORY_FILES.commands),
    init: path.join(root, MEMORY_FILES.init),
  };
}

export function ensureRunMemory(goalId: string, projectId: string): RunMemoryPaths {
  const paths = getRunMemoryPaths(goalId);
  mkdirp(paths.root);

  if (!fs.existsSync(paths.progress)) {
    fs.writeFileSync(paths.progress, '# Progress\n\n- Run initialized\n');
  }
  if (!fs.existsSync(paths.checklist)) {
    fs.writeFileSync(paths.checklist, '[]\n');
  }
  if (!fs.existsSync(paths.facts)) {
    fs.writeFileSync(paths.facts, '{}\n');
  }
  if (!fs.existsSync(paths.handoff)) {
    fs.writeFileSync(paths.handoff, '# Handoff\n\nNo handoff recorded yet.\n');
  }
  if (!fs.existsSync(paths.commands)) {
    fs.writeFileSync(paths.commands, '');
  }
  if (!fs.existsSync(paths.init)) {
    fs.writeFileSync(paths.init, defaultInitScript(projectId));
  }

  return paths;
}

export function appendCommandLog(goalId: string, entry: Record<string, unknown>): void {
  const { commands } = ensureRunMemory(goalId, 'organism');
  fs.appendFileSync(commands, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
}

export function updateRunProgress(goalId: string, lines: string[]): void {
  const { progress } = ensureRunMemory(goalId, 'organism');
  const body = ['# Progress', '', ...lines].join('\n');
  fs.writeFileSync(progress, body + '\n');
}

export function writeRunHandoff(goalId: string, markdown: string): void {
  const { handoff } = ensureRunMemory(goalId, 'organism');
  fs.writeFileSync(handoff, markdown.endsWith('\n') ? markdown : markdown + '\n');
}

export function mergeRunFacts(goalId: string, facts: Record<string, unknown>): void {
  const { facts: factsPath } = ensureRunMemory(goalId, 'organism');
  let current: Record<string, unknown> = {};
  if (fs.existsSync(factsPath)) {
    try {
      current = JSON.parse(fs.readFileSync(factsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  fs.writeFileSync(factsPath, JSON.stringify({ ...current, ...facts }, null, 2) + '\n');
}

export function setFeatureChecklist(goalId: string, items: Array<Record<string, unknown>>): void {
  const { checklist } = ensureRunMemory(goalId, 'organism');
  fs.writeFileSync(checklist, JSON.stringify(items, null, 2) + '\n');
}

export function readRunMemory(goalId: string): {
  progress: string;
  checklist: unknown[];
  facts: Record<string, unknown>;
  handoff: string;
  commandLog: string[];
} {
  const paths = ensureRunMemory(goalId, 'organism');
  const progress = fs.readFileSync(paths.progress, 'utf8');
  const handoff = fs.readFileSync(paths.handoff, 'utf8');
  const commandLog = fs.readFileSync(paths.commands, 'utf8').split('\n').filter(Boolean);

  let checklist: unknown[] = [];
  let facts: Record<string, unknown> = {};
  try { checklist = JSON.parse(fs.readFileSync(paths.checklist, 'utf8')) as unknown[]; } catch {}
  try { facts = JSON.parse(fs.readFileSync(paths.facts, 'utf8')) as Record<string, unknown>; } catch {}

  return { progress, checklist, facts, handoff, commandLog };
}
