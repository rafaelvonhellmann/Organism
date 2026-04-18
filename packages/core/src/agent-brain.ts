import * as fs from 'fs';
import * as path from 'path';
import { Task, TaskStatus } from '../../shared/src/types.js';

const DEFAULT_WORKSPACE = `# Workspace

This file is rendered from per-agent snapshots in \`.agent/memory/working/agents/\`.

## Active agents
_none_
`;

const DEFAULT_REVIEW_QUEUE = `# Review Queue

No pending portable lessons.
`;

const DEFAULT_PREFERENCES = `# Preferences

- Runtime: OpenAI-first via Codex CLI, OpenAI API fallback
- Review style: critical issues first, concise evidence, concrete remediation
- Safety posture: PR-only, no force push, no secret access, no ungated deploys
- Workflow preference: keep the next safe step moving automatically whenever possible
`;

const DEFAULT_DECISIONS = `# Decisions

- Paperclip in \`packages/core/\` is the only orchestrator.
- PraisonAI in \`packages/mcp-sidecar/\` is a restricted MCP tool provider only.
- OpenAI is the default company runtime; legacy Anthropic paths are opt-in only.
- Risk lanes control the review pipeline and deployment eligibility.
`;

const DEFAULT_LESSONS = `# Lessons

This file captures distilled portable lessons for Organism agents.
Review candidates are staged in \`.agent/memory/working/REVIEW_QUEUE.md\` before they should be promoted here.
`;

const DEFAULT_PERMISSIONS = `# Portable Permissions

These are portable agent-facing permissions that complement Organism's hard controller gates.

## Always allowed
- Read files inside the current project and configured repo paths.
- Run tests, lint, typecheck, build, and validation commands.
- Write to \`.agent/memory/\` and \`.agent/skills/\`.
- Create isolated worktrees and feature branches.

## Requires approval
- Deploy to any environment.
- Merge a pull request.
- Run destructive migrations.
- Install or upgrade dependencies outside an approved task.
- Access external services that create accounts, purchase resources, or contact people.

## Never allowed
- Force push protected branches.
- Bypass controller review gates.
- Expose secrets in prompts, logs, or committed files.
- Perform outreach, billing, or partner/customer communication autonomously.
`;

const DEFAULT_SKILL_INDEX = `# Portable Skill Index

- \`project-memory\` — capture stable working context for every agent run
- \`review-queue\` — stage recurring lessons for later human or host-agent review
- \`permissions-gate\` — remind agents of portable safe-action boundaries
- \`reliability-investigator\` — focus on root-cause debugging before cosmetic fixes
`;

const DEFAULT_SKILL_MANIFEST = [
  {
    name: 'project-memory',
    version: '2026-04-17',
    triggers: ['resume work', 'continue', 'handoff', 'working context'],
    constraints: ['update workspace snapshots before and after significant runs'],
    category: 'memory',
  },
  {
    name: 'review-queue',
    version: '2026-04-17',
    triggers: ['recurring failure', 'quality feedback', 'repeat bug', 'lesson learned'],
    constraints: ['stage lessons in review queue before promoting them to semantic memory'],
    category: 'memory',
  },
  {
    name: 'permissions-gate',
    version: '2026-04-17',
    triggers: ['deploy', 'merge', 'migration', 'secret', 'contact'],
    constraints: ['portable permissions never override stricter controller policy'],
    category: 'safety',
  },
  {
    name: 'reliability-investigator',
    version: '2026-04-17',
    triggers: ['why is this failing', 'stuck', 'retry', 'transport error', 'bridge unavailable'],
    constraints: ['prefer root cause over cosmetic retries'],
    category: 'operations',
  },
];

export interface PortableReviewCandidate {
  id: string;
  createdAt: number;
  status: 'pending' | 'accepted' | 'rejected';
  agent: string;
  projectId: string;
  taskId: string;
  kind: 'failure-pattern' | 'review-feedback' | 'success-pattern';
  summary: string;
  evidence: string;
}

export interface PortableLearningEntry {
  ts: number;
  agent: string;
  projectId: string;
  taskId: string;
  workflowKind: string;
  lane: string;
  status: TaskStatus | 'success';
  summary: string;
}

export interface PortableWorkspaceSnapshot {
  agent: string;
  projectId: string;
  taskId: string;
  lane: string;
  workflowKind: string;
  status: string;
  description: string;
  updatedAt: number;
  nextStep: string;
  detail?: string;
}

export interface PortableAgentContext {
  readOrder: string[];
  reviewQueueStatus: {
    pendingCount: number;
    oldestPendingAgeDays: number | null;
  };
  preferences: string;
  workspace: string;
  reviewQueue: string;
  decisions: string;
  lessons: string;
  permissions: string;
  skillManifest: string;
}

function stackPaths() {
  const agentStackDir = path.resolve(process.cwd(), '.agent');
  const memoryDir = path.join(agentStackDir, 'memory');
  const workingDir = path.join(memoryDir, 'working');
  const workingAgentsDir = path.join(workingDir, 'agents');
  const personalDir = path.join(memoryDir, 'personal');
  const semanticDir = path.join(memoryDir, 'semantic');
  const episodicDir = path.join(memoryDir, 'episodic');
  const protocolsDir = path.join(agentStackDir, 'protocols');
  const skillsDir = path.join(agentStackDir, 'skills');

  return {
    workingAgentsDir,
    personalDir,
    semanticDir,
    episodicDir,
    protocolsDir,
    skillsDir,
    workspacePath: path.join(workingDir, 'WORKSPACE.md'),
    reviewQueuePath: path.join(workingDir, 'REVIEW_QUEUE.md'),
    reviewCandidatesPath: path.join(workingDir, 'REVIEW_CANDIDATES.jsonl'),
    preferencesPath: path.join(personalDir, 'PREFERENCES.md'),
    decisionsPath: path.join(semanticDir, 'DECISIONS.md'),
    lessonsPath: path.join(semanticDir, 'LESSONS.md'),
    permissionsPath: path.join(protocolsDir, 'permissions.md'),
    skillIndexPath: path.join(skillsDir, '_index.md'),
    skillManifestPath: path.join(skillsDir, '_manifest.jsonl'),
    episodicPath: path.join(episodicDir, 'AGENT_LEARNINGS.jsonl'),
  };
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureFile(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function trimText(value: string, maxChars = 1800): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15))}\n...[truncated]`;
}

function readText(filePath: string, fallback: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : fallback;
  } catch {
    return fallback;
  }
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function writeJsonl<T>(filePath: string, rows: T[]): void {
  ensureDir(path.dirname(filePath));
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function renderReviewQueue(entries: PortableReviewCandidate[]): string {
  const pending = entries
    .filter((entry) => entry.status === 'pending')
    .sort((left, right) => right.createdAt - left.createdAt);

  if (pending.length === 0) {
    return DEFAULT_REVIEW_QUEUE;
  }

  const oldestAgeDays = Math.max(
    0,
    Math.floor((Date.now() - pending[pending.length - 1]!.createdAt) / (24 * 60 * 60 * 1000)),
  );

  const lines = [
    '# Review Queue',
    '',
    `Pending portable lessons: ${pending.length}`,
    `Oldest pending age: ${oldestAgeDays} day(s)`,
    '',
    '## Candidates',
  ];

  for (const entry of pending.slice(0, 15)) {
    lines.push(
      `- [${entry.kind}] ${entry.summary}`,
      `  Agent: ${entry.agent} | Project: ${entry.projectId} | Task: ${entry.taskId}`,
      `  Evidence: ${entry.evidence}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function renderWorkspace(): string {
  const paths = stackPaths();
  const files = fs.existsSync(paths.workingAgentsDir)
    ? fs.readdirSync(paths.workingAgentsDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => path.join(paths.workingAgentsDir, file))
    : [];

  const snapshots = files
    .flatMap((filePath) => {
      try {
        return [JSON.parse(fs.readFileSync(filePath, 'utf8')) as PortableWorkspaceSnapshot];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);

  if (snapshots.length === 0) {
    return DEFAULT_WORKSPACE;
  }

  const lines = [
    '# Workspace',
    '',
    'Live per-agent workspace snapshots.',
    '',
    '## Active agents',
  ];

  for (const snapshot of snapshots.slice(0, 12)) {
    lines.push(
      `- ${snapshot.agent} — ${snapshot.status} — ${snapshot.projectId} — ${snapshot.workflowKind}`,
      `  Task: ${snapshot.description}`,
      `  Next: ${snapshot.nextStep}`,
      `  Updated: ${new Date(snapshot.updatedAt).toISOString()}`,
    );
    if (snapshot.detail) {
      lines.push(`  Detail: ${snapshot.detail}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function loadReviewCandidates(): PortableReviewCandidate[] {
  return readJsonl<PortableReviewCandidate>(stackPaths().reviewCandidatesPath);
}

function saveReviewCandidates(entries: PortableReviewCandidate[]): void {
  const paths = stackPaths();
  writeJsonl(paths.reviewCandidatesPath, entries);
  fs.writeFileSync(paths.reviewQueuePath, renderReviewQueue(entries), 'utf8');
}

function renderSkillManifest(): string {
  const paths = stackPaths();
  return readText(
    paths.skillManifestPath,
    `${DEFAULT_SKILL_MANIFEST.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
}

export function ensurePortableAgentStack(): void {
  const paths = stackPaths();
  ensureDir(paths.workingAgentsDir);
  ensureDir(paths.personalDir);
  ensureDir(paths.semanticDir);
  ensureDir(paths.episodicDir);
  ensureDir(paths.protocolsDir);
  ensureDir(paths.skillsDir);

  ensureFile(paths.workspacePath, DEFAULT_WORKSPACE);
  ensureFile(paths.reviewQueuePath, DEFAULT_REVIEW_QUEUE);
  ensureFile(paths.preferencesPath, DEFAULT_PREFERENCES);
  ensureFile(paths.decisionsPath, DEFAULT_DECISIONS);
  ensureFile(paths.lessonsPath, DEFAULT_LESSONS);
  ensureFile(paths.permissionsPath, DEFAULT_PERMISSIONS);
  ensureFile(paths.skillIndexPath, DEFAULT_SKILL_INDEX);
  ensureFile(
    paths.skillManifestPath,
    `${DEFAULT_SKILL_MANIFEST.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
  ensureFile(paths.episodicPath, '');
  ensureFile(paths.reviewCandidatesPath, '');

  fs.writeFileSync(paths.workspacePath, renderWorkspace(), 'utf8');
  fs.writeFileSync(paths.reviewQueuePath, renderReviewQueue(loadReviewCandidates()), 'utf8');
}

export function loadPortableAgentContext(): PortableAgentContext {
  ensurePortableAgentStack();
  const paths = stackPaths();

  const candidates = loadReviewCandidates().filter((entry) => entry.status === 'pending');
  const oldestPendingAgeDays = candidates.length > 0
    ? Math.max(0, Math.floor((Date.now() - Math.min(...candidates.map((entry) => entry.createdAt))) / (24 * 60 * 60 * 1000)))
    : null;

  return {
    readOrder: [
      '.agent/memory/personal/PREFERENCES.md',
      '.agent/memory/working/WORKSPACE.md',
      '.agent/memory/working/REVIEW_QUEUE.md',
      '.agent/memory/semantic/DECISIONS.md',
      '.agent/memory/semantic/LESSONS.md',
      '.agent/protocols/permissions.md',
      '.agent/skills/_manifest.jsonl',
    ],
    reviewQueueStatus: {
      pendingCount: candidates.length,
      oldestPendingAgeDays,
    },
    preferences: trimText(readText(paths.preferencesPath, DEFAULT_PREFERENCES)),
    workspace: trimText(readText(paths.workspacePath, DEFAULT_WORKSPACE)),
    reviewQueue: trimText(readText(paths.reviewQueuePath, DEFAULT_REVIEW_QUEUE)),
    decisions: trimText(readText(paths.decisionsPath, DEFAULT_DECISIONS)),
    lessons: trimText(readText(paths.lessonsPath, DEFAULT_LESSONS)),
    permissions: trimText(readText(paths.permissionsPath, DEFAULT_PERMISSIONS)),
    skillManifest: trimText(renderSkillManifest(), 1200),
  };
}

export function updatePortableWorkspace(snapshot: PortableWorkspaceSnapshot): void {
  ensurePortableAgentStack();
  const paths = stackPaths();
  const filePath = path.join(paths.workingAgentsDir, `${snapshot.agent}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.writeFileSync(paths.workspacePath, renderWorkspace(), 'utf8');
}

export function appendPortableLearning(entry: PortableLearningEntry): void {
  ensurePortableAgentStack();
  fs.appendFileSync(stackPaths().episodicPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export function stagePortableReviewCandidate(candidate: Omit<PortableReviewCandidate, 'id' | 'createdAt' | 'status'>): PortableReviewCandidate {
  ensurePortableAgentStack();
  const existing = loadReviewCandidates();
  const duplicate = existing.find((entry) =>
    entry.status === 'pending'
    && entry.taskId === candidate.taskId
    && entry.kind === candidate.kind
    && entry.summary === candidate.summary,
  );
  if (duplicate) {
    return duplicate;
  }

  const entry: PortableReviewCandidate = {
    id: `candidate-${candidate.taskId}-${Date.now()}`,
    createdAt: Date.now(),
    status: 'pending',
    ...candidate,
  };
  existing.push(entry);
  saveReviewCandidates(existing);
  return entry;
}

export function buildPortableWorkspaceSnapshot(task: Task, agent: string, status: string, nextStep: string, detail?: string): PortableWorkspaceSnapshot {
  return {
    agent,
    projectId: task.projectId ?? 'organism',
    taskId: task.id,
    lane: task.lane,
    workflowKind: task.workflowKind ?? 'implement',
    status,
    description: task.description,
    updatedAt: Date.now(),
    nextStep,
    detail,
  };
}
