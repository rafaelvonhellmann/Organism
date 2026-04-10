import { getClient, getAgentMeta, ensureTables } from './db';
import { getAgentCap, getBudgetStatus, SYSTEM_DAILY_CAP } from './constants';
import type { Client, Row, InArgs } from '@libsql/client';

const todayStr = () => new Date().toISOString().slice(0, 10);
const todayStartMs = () => new Date(todayStr()).getTime();

// ── Helpers ─────────────────────────────────────────────────────

function n(v: unknown): number { return Number(v) || 0; }
function s(v: unknown): string { return v == null ? '' : String(v); }

async function scalar(client: Client, sql: string, args?: InArgs): Promise<number> {
  const result = args ? await client.execute({ sql, args }) : await client.execute(sql);
  if (result.rows.length === 0) return 0;
  return n(Object.values(result.rows[0])[0]);
}

function esc(v: string): string { return v.replace(/'/g, "''"); }

function tryParse(json: unknown): unknown {
  if (!json || typeof json !== 'string') return json ?? null;
  try { return JSON.parse(json); } catch { return json; }
}

function formatTask(row: Row) {
  return {
    id: s(row.id),
    agent: s(row.agent),
    status: s(row.status),
    lane: s(row.lane),
    description: s(row.description),
    input: tryParse(row.input),
    output: tryParse(row.output),
    tokensUsed: row.tokens_used != null ? n(row.tokens_used) : null,
    costUsd: row.cost_usd != null ? n(row.cost_usd) : null,
    startedAt: row.started_at != null ? n(row.started_at) : null,
    completedAt: row.completed_at != null ? n(row.completed_at) : null,
    error: row.error ? s(row.error) : null,
    parentTaskId: row.parent_task_id ? s(row.parent_task_id) : null,
    projectId: s(row.project_id),
    createdAt: n(row.created_at),
  };
}

function formatAudit(row: Row) {
  return {
    id: n(row.id),
    ts: n(row.ts),
    agent: s(row.agent),
    taskId: s(row.task_id),
    action: s(row.action),
    payload: tryParse(row.payload),
    outcome: s(row.outcome),
    errorCode: row.error_code ? s(row.error_code) : null,
  };
}

// ── System overview ─────────────────────────────────────────────

export async function getSystemOverview(projectId?: string) {
  const client = getClient();
  if (!client) return emptyOverview();

  const pf = projectId ? ` AND project_id = '${esc(projectId)}'` : '';
  const date = todayStr();
  const dayStart = todayStartMs();

  const [pending, inProgress, deadLetter, completedToday, failedToday, systemSpend, activityResult] =
    await Promise.all([
      scalar(client, `SELECT COUNT(*) as c FROM tasks WHERE status='pending'${pf}`),
      scalar(client, `SELECT COUNT(*) as c FROM tasks WHERE status='in_progress'${pf}`),
      scalar(client, `SELECT COUNT(*) as c FROM tasks WHERE status='dead_letter'${pf}`),
      scalar(client, `SELECT COUNT(*) as c FROM tasks WHERE status='completed' AND completed_at >= ${dayStart}${pf}`),
      scalar(client, `SELECT COUNT(*) as c FROM tasks WHERE status='failed' AND completed_at >= ${dayStart}${pf}`),
      scalar(client, `SELECT COALESCE(SUM(cost_usd), 0) as c FROM agent_spend WHERE date='${date}'`),
      client.execute('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 15'),
    ]);

  const alerts: string[] = [];
  if (deadLetter > 0) alerts.push(`${deadLetter} dead-letter task(s) need attention`);
  const spendPct = (systemSpend / SYSTEM_DAILY_CAP) * 100;
  if (spendPct >= 80) alerts.push(`System spend at ${spendPct.toFixed(0)}% of daily cap`);

  return {
    pendingCount: pending,
    inProgressCount: inProgress,
    deadLetterCount: deadLetter,
    completedToday,
    failedToday,
    systemSpend,
    systemCap: SYSTEM_DAILY_CAP,
    alerts,
    recentActivity: activityResult.rows.map(formatAudit),
  };
}

function emptyOverview() {
  return {
    pendingCount: 0, inProgressCount: 0, deadLetterCount: 0,
    completedToday: 0, failedToday: 0, systemSpend: 0,
    systemCap: SYSTEM_DAILY_CAP, alerts: ['Database not connected'],
    recentActivity: [],
  };
}

// ── Agent list ──────────────────────────────────────────────────

export async function getAgents(projectId?: string) {
  const client = getClient();
  const meta = getAgentMeta();
  const date = todayStr();
  const dayStart = todayStartMs();
  const pf = projectId ? ` AND project_id = '${esc(projectId)}'` : '';

  // Batch queries for efficiency (4 queries instead of 4*N)
  const spendMap = new Map<string, number>();
  const pendingMap = new Map<string, number>();
  const completedMap = new Map<string, number>();
  const currentTasks = new Map<string, { id: string; description: string; lane: string }>();

  if (client) {
    const [spendResult, pendingResult, completedResult, currentResult] = await Promise.all([
      client.execute(`SELECT agent, COALESCE(SUM(cost_usd), 0) as spent FROM agent_spend WHERE date='${date}' GROUP BY agent`),
      client.execute(`SELECT agent, COUNT(*) as c FROM tasks WHERE status='pending'${pf} GROUP BY agent`),
      client.execute(`SELECT agent, COUNT(*) as c FROM tasks WHERE status='completed' AND completed_at >= ${dayStart}${pf} GROUP BY agent`),
      client.execute(`SELECT agent, id, description, lane FROM tasks WHERE status='in_progress' ORDER BY started_at DESC`),
    ]);

    for (const row of spendResult.rows) spendMap.set(s(row.agent), n(row.spent));
    for (const row of pendingResult.rows) pendingMap.set(s(row.agent), n(row.c));
    for (const row of completedResult.rows) completedMap.set(s(row.agent), n(row.c));
    for (const row of currentResult.rows) {
      const agent = s(row.agent);
      if (!currentTasks.has(agent)) {
        currentTasks.set(agent, { id: s(row.id), description: s(row.description), lane: s(row.lane) });
      }
    }
  }

  const agents: AgentInfo[] = [];
  for (const [name, info] of meta) {
    const spent = spendMap.get(name) ?? 0;
    const cap = getAgentCap(name);
    const pct = cap > 0 ? (spent / cap) * 100 : 0;

    agents.push({
      name,
      status: info.status,
      model: info.model,
      description: info.description,
      capabilities: info.capabilities,
      frequencyTier: info.frequencyTier,
      spent,
      cap,
      pct: Math.round(pct * 10) / 10,
      budgetStatus: getBudgetStatus(pct),
      pendingTasks: pendingMap.get(name) ?? 0,
      completedToday: completedMap.get(name) ?? 0,
      currentTask: currentTasks.get(name) ?? null,
    });
  }

  return agents.sort((a, b) => {
    const order = { active: 0, shadow: 1, suspended: 2 };
    const d = order[a.status] - order[b.status];
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
}

// ── Task list ───────────────────────────────────────────────────

export async function getTasks(filters: {
  status?: string;
  agent?: string;
  project?: string;
  lane?: string;
  limit?: number;
  offset?: number;
}) {
  const client = getClient();
  if (!client) return { tasks: [], total: 0 };

  // Auto-complete non-HIGH awaiting_review tasks — they don't need Rafael's review
  if (filters.status === 'awaiting_review') {
    try {
      await client.execute(`
        UPDATE tasks SET status = 'completed', completed_at = ${Date.now()}
        WHERE status = 'awaiting_review' AND lane != 'HIGH'
          AND agent NOT IN ('grill-me', 'codex-review', 'quality-agent')
      `);
    } catch { /* best effort */ }
  }

  const where: string[] = [];
  if (filters.status) where.push(`status='${esc(filters.status)}'`);
  if (filters.agent) where.push(`agent='${esc(filters.agent)}'`);
  if (filters.project) where.push(`project_id='${esc(filters.project)}'`);
  if (filters.lane) where.push(`lane='${esc(filters.lane)}'`);

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const [totalResult, tasksResult] = await Promise.all([
    scalar(client, `SELECT COUNT(*) as c FROM tasks ${whereClause}`),
    client.execute(`SELECT * FROM tasks ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`),
  ]);

  return {
    tasks: tasksResult.rows.map(formatTask),
    total: totalResult,
  };
}

// ── Task detail ─────────────────────────────────────────────────

export async function getTaskDetail(id: string) {
  const client = getClient();
  if (!client) return null;

  const taskResult = await client.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [id] });
  if (taskResult.rows.length === 0) return null;
  const row = taskResult.rows[0];

  const [auditResult, gatesResult, childrenResult] = await Promise.all([
    client.execute({ sql: 'SELECT * FROM audit_log WHERE task_id = ? ORDER BY ts ASC', args: [id] }),
    client.execute({ sql: 'SELECT * FROM gates WHERE task_id = ? ORDER BY created_at ASC', args: [id] }),
    client.execute({
      sql: 'SELECT id, agent, status, lane, description, created_at FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC',
      args: [id],
    }),
  ]);

  let parent = null;
  if (row.parent_task_id) {
    const pResult = await client.execute({
      sql: 'SELECT id, agent, status, lane, description FROM tasks WHERE id = ?',
      args: [s(row.parent_task_id)],
    });
    if (pResult.rows.length > 0) parent = formatTask(pResult.rows[0]);
  }

  // Find prev/next sibling tasks (same project, ordered by created_at desc)
  const projectId = s(row.project_id);
  const createdAt = n(row.created_at);

  const [prevResult, nextResult] = await Promise.all([
    client.execute({
      sql: `SELECT id FROM tasks WHERE project_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 1`,
      args: [projectId, createdAt],
    }),
    client.execute({
      sql: `SELECT id FROM tasks WHERE project_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1`,
      args: [projectId, createdAt],
    }),
  ]);

  return {
    task: formatTask(row),
    auditTrail: auditResult.rows.map(formatAudit),
    gates: gatesResult.rows.map(g => ({
      id: s(g.id),
      gate: s(g.gate),
      decision: s(g.decision),
      decidedBy: g.decided_by ? s(g.decided_by) : null,
      reason: g.reason ? s(g.reason) : null,
      decidedAt: g.decided_at != null ? n(g.decided_at) : null,
    })),
    childTasks: childrenResult.rows.map(formatTask),
    parentTask: parent,
    prevTaskId: prevResult.rows.length > 0 ? s(prevResult.rows[0].id) : null,
    nextTaskId: nextResult.rows.length > 0 ? s(nextResult.rows[0].id) : null,
  };
}

// ── Budget ──────────────────────────────────────────────────────

export async function getBudgetSummary() {
  const client = getClient();
  const meta = getAgentMeta();
  const date = todayStr();

  const spendMap = new Map<string, number>();
  let systemSpend = 0;

  if (client) {
    const result = await client.execute(
      `SELECT agent, COALESCE(SUM(cost_usd), 0) as spent FROM agent_spend WHERE date='${date}' GROUP BY agent`,
    );
    for (const row of result.rows) spendMap.set(s(row.agent), n(row.spent));
  }

  const agents: BudgetAgent[] = [];
  for (const [name] of meta) {
    const spent = spendMap.get(name) ?? 0;
    const cap = getAgentCap(name);
    const pct = cap > 0 ? (spent / cap) * 100 : 0;
    systemSpend += spent;
    agents.push({
      name,
      spent,
      cap,
      pct: Math.round(pct * 10) / 10,
      status: getBudgetStatus(pct),
    });
  }

  agents.sort((a, b) => b.pct - a.pct);

  return {
    date,
    systemSpend,
    systemCap: SYSTEM_DAILY_CAP,
    systemPct: Math.round((systemSpend / SYSTEM_DAILY_CAP) * 1000) / 10,
    agents,
  };
}

// ── Projects ────────────────────────────────────────────────────

export async function getProjects() {
  const client = getClient();
  if (!client) return ['organism'];
  const result = await client.execute('SELECT DISTINCT project_id FROM tasks ORDER BY project_id');
  const projects = result.rows.map(r => s(r.project_id));
  if (!projects.includes('organism')) projects.unshift('organism');
  return projects;
}

// ── Action Items ───────────────────────────────────────────────

export async function getActionItems(filters: {
  project?: string;
  status?: string;
  priority?: string;
}) {
  const client = getClient();
  if (!client) return [];

  const where: string[] = [];
  if (filters.project) where.push(`project_id='${esc(filters.project)}'`);
  if (filters.status) where.push(`status='${esc(filters.status)}'`);
  if (filters.priority) where.push(`priority='${esc(filters.priority)}'`);

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const result = await client.execute(
    `SELECT * FROM action_items ${whereClause} ORDER BY
      CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END,
      due_date ASC,
      created_at DESC
    LIMIT 500`
  );

  return result.rows.map(formatActionItem);
}

export async function getActionItemCounts(projectId?: string) {
  const client = getClient();
  if (!client) return { todo: 0, in_progress: 0, done: 0, total: 0 };

  const pf = projectId ? ` WHERE project_id = '${esc(projectId)}'` : '';

  const result = await client.execute(
    `SELECT status, COUNT(*) as c FROM action_items${pf} GROUP BY status`
  );

  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    counts[s(row.status)] = n(row.c);
  }

  return {
    todo: counts['todo'] ?? 0,
    in_progress: counts['in_progress'] ?? 0,
    done: counts['done'] ?? 0,
    total: (counts['todo'] ?? 0) + (counts['in_progress'] ?? 0) + (counts['done'] ?? 0),
  };
}

export async function createActionItem(item: {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: string;
  sourceTaskId?: string;
  sourceAgent?: string;
  dueDate?: string;
}) {
  const client = getClient();
  if (!client) return null;

  const now = Date.now();

  await client.execute({
    sql: `INSERT INTO action_items (id, project_id, title, description, priority, status, source_task_id, source_agent, due_date, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?)`,
    args: [
      item.id,
      item.projectId,
      item.title,
      item.description,
      item.priority,
      item.sourceTaskId ?? null,
      item.sourceAgent ?? null,
      item.dueDate ?? null,
      now,
      now,
    ],
  });

  return { id: item.id, status: 'todo', createdAt: now };
}

export async function updateActionItem(id: string, updates: {
  status?: string;
  priority?: string;
  rafaelNotes?: string;
  title?: string;
  description?: string;
  dueDate?: string;
}) {
  const client = getClient();
  if (!client) return null;

  const sets: string[] = [];
  const args: (string | number | null)[] = [];

  if (updates.status) { sets.push('status = ?'); args.push(updates.status); }
  if (updates.priority) { sets.push('priority = ?'); args.push(updates.priority); }
  if (updates.rafaelNotes !== undefined) { sets.push('rafael_notes = ?'); args.push(updates.rafaelNotes); }
  if (updates.title) { sets.push('title = ?'); args.push(updates.title); }
  if (updates.description !== undefined) { sets.push('description = ?'); args.push(updates.description); }
  if (updates.dueDate !== undefined) { sets.push('due_date = ?'); args.push(updates.dueDate); }

  if (sets.length === 0) return null;

  sets.push('updated_at = ?');
  args.push(Date.now());
  args.push(id);

  await client.execute({
    sql: `UPDATE action_items SET ${sets.join(', ')} WHERE id = ?`,
    args,
  });

  return { id, updated: true };
}

function formatActionItem(row: Row) {
  return {
    id: s(row.id),
    projectId: s(row.project_id),
    title: s(row.title),
    description: s(row.description),
    priority: s(row.priority),
    status: s(row.status),
    sourceTaskId: row.source_task_id ? s(row.source_task_id) : null,
    sourceAgent: row.source_agent ? s(row.source_agent) : null,
    dueDate: row.due_date ? s(row.due_date) : null,
    createdAt: n(row.created_at),
    updatedAt: row.updated_at ? n(row.updated_at) : null,
    rafaelNotes: row.rafael_notes ? s(row.rafael_notes) : null,
  };
}

// ── Shape Up: Pitches ─────────────────────────────────────────────

export async function getPitches(filters: { project?: string; status?: string }) {
  const client = getClient();
  if (!client) return [];

  const where: string[] = [];
  if (filters.project) where.push(`project_id='${esc(filters.project)}'`);
  if (filters.status) where.push(`status='${esc(filters.status)}'`);

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const result = await client.execute(
    `SELECT * FROM pitches ${whereClause} ORDER BY created_at DESC LIMIT 200`
  );

  return result.rows.map(formatPitch);
}

function formatPitch(row: Row) {
  return {
    id: s(row.id),
    title: s(row.title),
    problem: s(row.problem),
    appetite: s(row.appetite),
    solutionSketch: s(row.solution_sketch),
    rabbitHoles: s(row.rabbit_holes),
    noGos: s(row.no_gos),
    shapedBy: s(row.shaped_by),
    projectId: s(row.project_id),
    status: s(row.status),
    createdAt: n(row.created_at),
    updatedAt: n(row.updated_at),
  };
}

// ── Shape Up: Bets ───────────────────────────────────────────────

export async function getBets(filters: { project?: string; status?: string }) {
  const client = getClient();
  if (!client) return [];

  const where: string[] = [];
  if (filters.project) where.push(`project_id='${esc(filters.project)}'`);
  if (filters.status) where.push(`status='${esc(filters.status)}'`);

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const result = await client.execute(
    `SELECT * FROM bets ${whereClause} ORDER BY created_at DESC LIMIT 200`
  );

  return result.rows.map(formatBet);
}

export async function getBetDetail(betId: string) {
  const client = getClient();
  if (!client) return null;

  const betResult = await client.execute({ sql: 'SELECT * FROM bets WHERE id = ?', args: [betId] });
  if (betResult.rows.length === 0) return null;

  const [scopesResult, hillResult, decisionsResult, tasksResult] = await Promise.all([
    client.execute({ sql: 'SELECT * FROM bet_scopes WHERE bet_id = ? ORDER BY created_at ASC', args: [betId] }),
    client.execute({ sql: 'SELECT * FROM hill_updates WHERE bet_id = ? ORDER BY created_at DESC LIMIT 50', args: [betId] }),
    client.execute({ sql: 'SELECT * FROM bet_decisions WHERE bet_id = ? ORDER BY created_at ASC', args: [betId] }),
    client.execute({ sql: 'SELECT id, agent, status, lane, description, created_at FROM tasks WHERE bet_id = ? ORDER BY created_at DESC LIMIT 50', args: [betId] }),
  ]);

  return {
    bet: formatBet(betResult.rows[0]),
    scopes: scopesResult.rows.map(formatScope),
    hillUpdates: hillResult.rows.map(formatHillUpdate),
    decisions: decisionsResult.rows.map(formatBetDecision),
    tasks: tasksResult.rows.map(formatTask),
  };
}

function formatBet(row: Row) {
  return {
    id: s(row.id),
    pitchId: row.pitch_id ? s(row.pitch_id) : null,
    title: s(row.title),
    problem: s(row.problem),
    appetite: s(row.appetite),
    status: s(row.status),
    shapedBy: s(row.shaped_by),
    approvedBy: row.approved_by ? s(row.approved_by) : null,
    tokenBudget: n(row.token_budget),
    costBudgetUsd: n(row.cost_budget_usd),
    tokensUsed: n(row.tokens_used),
    costUsedUsd: n(row.cost_used_usd),
    noGos: s(row.no_gos),
    rabbitHoles: s(row.rabbit_holes),
    successCriteria: s(row.success_criteria),
    projectId: s(row.project_id),
    createdAt: n(row.created_at),
    updatedAt: n(row.updated_at),
  };
}

function formatScope(row: Row) {
  return {
    id: s(row.id),
    betId: s(row.bet_id),
    title: s(row.title),
    description: s(row.description),
    hillPhase: s(row.hill_phase),
    hillProgress: n(row.hill_progress),
    completed: !!n(row.completed),
    createdAt: n(row.created_at),
    updatedAt: n(row.updated_at),
  };
}

function formatHillUpdate(row: Row) {
  return {
    id: s(row.id),
    betId: s(row.bet_id),
    scopeId: row.scope_id ? s(row.scope_id) : null,
    hillProgress: n(row.hill_progress),
    note: s(row.note),
    agent: s(row.agent),
    createdAt: n(row.created_at),
  };
}

function formatBetDecision(row: Row) {
  return {
    id: s(row.id),
    betId: s(row.bet_id),
    decision: s(row.decision),
    reason: s(row.reason),
    decidedBy: s(row.decided_by),
    exceptionType: row.exception_type ? s(row.exception_type) : null,
    createdAt: n(row.created_at),
  };
}

// ── Shape Up: Paused Bets / Exceptions ───────────────────────────

export async function getPausedBets() {
  const client = getClient();
  if (!client) return [];

  const result = await client.execute(
    `SELECT b.*, bd.reason as pause_reason, bd.exception_type, bd.created_at as paused_at
     FROM bets b
     LEFT JOIN bet_decisions bd ON bd.bet_id = b.id AND bd.decision = 'paused'
     WHERE b.status = 'paused'
     ORDER BY b.updated_at DESC`
  );

  return result.rows.map(row => ({
    ...formatBet(row),
    pauseReason: row.pause_reason ? s(row.pause_reason) : null,
    exceptionType: row.exception_type ? s(row.exception_type) : null,
    pausedAt: row.paused_at ? n(row.paused_at) : null,
  }));
}

// ── Shape Up: Bet Approve / Reject ──────────────────────────────

export async function approveBetFromDashboard(betId: string, approvedBy: string, notes?: string) {
  const client = getClient();
  if (!client) return null;

  // Only allow transition from pitch_ready
  const existing = await client.execute({ sql: 'SELECT * FROM bets WHERE id = ?', args: [betId] });
  if (existing.rows.length === 0) return null;
  const bet = existing.rows[0];
  if (s(bet.status) !== 'pitch_ready') return null;

  const now = Date.now();
  const decisionId = crypto.randomUUID();

  await client.batch([
    {
      sql: `UPDATE bets SET status = 'bet_approved', approved_by = ?, updated_at = ? WHERE id = ?`,
      args: [approvedBy, now, betId],
    },
    {
      sql: `INSERT INTO bet_decisions (id, bet_id, decision, reason, decided_by, exception_type, created_at) VALUES (?, ?, 'approved', ?, ?, NULL, ?)`,
      args: [decisionId, betId, notes ?? 'Bet approved from dashboard', approvedBy, now],
    },
  ], 'write');

  const updated = await client.execute({ sql: 'SELECT * FROM bets WHERE id = ?', args: [betId] });
  return updated.rows.length > 0 ? formatBet(updated.rows[0]) : null;
}

export async function rejectBetFromDashboard(betId: string, rejectedBy: string, notes?: string) {
  const client = getClient();
  if (!client) return null;

  // Only allow transition from pitch_ready
  const existing = await client.execute({ sql: 'SELECT * FROM bets WHERE id = ?', args: [betId] });
  if (existing.rows.length === 0) return null;
  const bet = existing.rows[0];
  if (s(bet.status) !== 'pitch_ready') return null;

  const now = Date.now();
  const decisionId = crypto.randomUUID();

  await client.batch([
    {
      sql: `UPDATE bets SET status = 'cancelled', updated_at = ? WHERE id = ?`,
      args: [now, betId],
    },
    {
      sql: `INSERT INTO bet_decisions (id, bet_id, decision, reason, decided_by, exception_type, created_at) VALUES (?, ?, 'rejected', ?, ?, NULL, ?)`,
      args: [decisionId, betId, notes ?? 'Bet rejected from dashboard', rejectedBy, now],
    },
  ], 'write');

  const updated = await client.execute({ sql: 'SELECT * FROM bets WHERE id = ?', args: [betId] });
  return updated.rows.length > 0 ? formatBet(updated.rows[0]) : null;
}

// ── External Feedback (Agentation pilot) ─────────────────────────

export type FeedbackStatus = 'pending' | 'acknowledged' | 'resolved' | 'dismissed' | 'converted';

export interface ExternalFeedbackRecord {
  id: string;
  source: string;
  sessionId: string | null;
  externalId: string;
  pageUrl: string | null;
  annotationKind: string | null;
  body: string;
  status: FeedbackStatus;
  severity: string | null;
  rawPayload: unknown;
  linkedTaskId: string | null;
  linkedActionItemId: string | null;
  createdAt: number;
  updatedAt: number;
}

function formatFeedback(row: Row): ExternalFeedbackRecord {
  return {
    id: s(row.id),
    source: s(row.source),
    sessionId: row.session_id ? s(row.session_id) : null,
    externalId: s(row.external_id),
    pageUrl: row.page_url ? s(row.page_url) : null,
    annotationKind: row.annotation_kind ? s(row.annotation_kind) : null,
    body: s(row.body),
    status: s(row.status) as FeedbackStatus,
    severity: row.severity ? s(row.severity) : null,
    rawPayload: tryParse(row.raw_payload),
    linkedTaskId: row.linked_task_id ? s(row.linked_task_id) : null,
    linkedActionItemId: row.linked_action_item_id ? s(row.linked_action_item_id) : null,
    createdAt: n(row.created_at),
    updatedAt: n(row.updated_at),
  };
}

export async function getExternalFeedback(filters: {
  status?: string;
  sessionId?: string;
  source?: string;
}): Promise<ExternalFeedbackRecord[]> {
  const client = getClient();
  if (!client) return [];

  const where: string[] = [];
  if (filters.status) where.push(`status='${esc(filters.status)}'`);
  if (filters.sessionId) where.push(`session_id='${esc(filters.sessionId)}'`);
  if (filters.source) where.push(`source='${esc(filters.source)}'`);

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const result = await client.execute(
    `SELECT * FROM external_feedback ${whereClause} ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'acknowledged' THEN 1 WHEN 'converted' THEN 2 WHEN 'resolved' THEN 3 ELSE 4 END,
      created_at DESC
    LIMIT 500`
  );

  return result.rows.map(formatFeedback);
}

export async function getExternalFeedbackCounts(): Promise<Record<string, number>> {
  const client = getClient();
  if (!client) return {};

  const result = await client.execute(
    `SELECT status, COUNT(*) as c FROM external_feedback GROUP BY status`
  );

  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    counts[s(row.status)] = n(row.c);
  }
  return counts;
}

export async function getFeedbackSessions(): Promise<Array<{
  sessionId: string;
  count: number;
  pendingCount: number;
  latestPageUrl: string | null;
}>> {
  const client = getClient();
  if (!client) return [];

  const result = await client.execute(
    `SELECT session_id,
            COUNT(*) as total,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
            MAX(page_url) as latest_page_url
     FROM external_feedback
     WHERE session_id IS NOT NULL
     GROUP BY session_id
     ORDER BY MAX(created_at) DESC
     LIMIT 100`
  );

  return result.rows.map(row => ({
    sessionId: s(row.session_id),
    count: n(row.total),
    pendingCount: n(row.pending),
    latestPageUrl: row.latest_page_url ? s(row.latest_page_url) : null,
  }));
}

/**
 * Import a single annotation into external_feedback.
 * Returns the new record ID, or null if a duplicate was detected.
 */
export async function importFeedbackAnnotation(params: {
  source: string;
  sessionId: string | null;
  externalId: string;
  pageUrl: string | null;
  annotationKind: string | null;
  body: string;
  severity: string | null;
  rawPayload: unknown;
}): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  // Duplicate check: same source + external_id
  const existing = await client.execute({
    sql: `SELECT id FROM external_feedback WHERE source = ? AND external_id = ?`,
    args: [params.source, params.externalId],
  });
  if (existing.rows.length > 0) {
    return null; // duplicate — skip
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  await client.execute({
    sql: `INSERT INTO external_feedback
          (id, source, session_id, external_id, page_url, annotation_kind, body, status, severity, raw_payload, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    args: [
      id,
      params.source,
      params.sessionId ?? null,
      params.externalId,
      params.pageUrl ?? null,
      params.annotationKind ?? null,
      params.body,
      params.severity ?? null,
      params.rawPayload ? JSON.stringify(params.rawPayload) : null,
      now,
      now,
    ],
  });

  return id;
}

/**
 * Update feedback status. Valid transitions:
 *   pending -> acknowledged | dismissed
 *   acknowledged -> resolved | dismissed | converted
 *   converted -> resolved
 */
export async function updateFeedbackStatus(
  id: string,
  newStatus: FeedbackStatus,
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  const existing = await client.execute({
    sql: `SELECT status FROM external_feedback WHERE id = ?`,
    args: [id],
  });
  if (existing.rows.length === 0) return false;

  const current = s(existing.rows[0].status) as FeedbackStatus;

  // Validate state transitions
  const validTransitions: Record<string, string[]> = {
    pending: ['acknowledged', 'dismissed'],
    acknowledged: ['resolved', 'dismissed', 'converted'],
    converted: ['resolved'],
  };

  if (!validTransitions[current]?.includes(newStatus)) {
    return false;
  }

  await client.execute({
    sql: `UPDATE external_feedback SET status = ?, updated_at = ? WHERE id = ?`,
    args: [newStatus, Date.now(), id],
  });
  return true;
}

/**
 * Link feedback to an action item (after converting annotation to a task).
 */
export async function linkFeedbackToActionItem(
  feedbackId: string,
  actionItemId: string,
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  await client.execute({
    sql: `UPDATE external_feedback SET linked_action_item_id = ?, status = 'converted', updated_at = ? WHERE id = ?`,
    args: [actionItemId, Date.now(), feedbackId],
  });
  return true;
}

/**
 * Convert a feedback item into an action item. Creates the action item
 * and links it back to the feedback record. Returns the action item ID.
 */
export async function convertFeedbackToActionItem(
  feedbackId: string,
  overrides: {
    projectId: string;
    title?: string;
    priority?: string;
  },
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  // Get the feedback record
  const fbResult = await client.execute({
    sql: `SELECT * FROM external_feedback WHERE id = ?`,
    args: [feedbackId],
  });
  if (fbResult.rows.length === 0) return null;
  const fb = formatFeedback(fbResult.rows[0]);

  // Don't re-convert
  if (fb.status === 'converted' || fb.status === 'resolved' || fb.status === 'dismissed') {
    return fb.linkedActionItemId;
  }

  // Map severity to priority
  const severityToPriority: Record<string, string> = {
    critical: 'HIGH',
    high: 'HIGH',
    medium: 'MEDIUM',
    low: 'LOW',
    info: 'LOW',
  };

  const actionId = crypto.randomUUID();
  const now = Date.now();
  const title = overrides.title ?? `[Feedback] ${fb.body.slice(0, 80)}`;
  const priority = overrides.priority ?? severityToPriority[fb.severity ?? 'medium'] ?? 'MEDIUM';

  const description = [
    fb.body,
    '',
    `Source: ${fb.source}`,
    fb.pageUrl ? `Page: ${fb.pageUrl}` : null,
    fb.annotationKind ? `Kind: ${fb.annotationKind}` : null,
    fb.severity ? `Severity: ${fb.severity}` : null,
    `External ID: ${fb.externalId}`,
  ].filter(Boolean).join('\n');

  await client.batch([
    {
      sql: `INSERT INTO action_items
            (id, project_id, title, description, priority, status, source_task_id, source_agent, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'todo', NULL, 'agentation', ?, ?)`,
      args: [actionId, overrides.projectId, title, description, priority, now, now],
    },
    {
      sql: `UPDATE external_feedback SET status = 'converted', linked_action_item_id = ?, updated_at = ? WHERE id = ?`,
      args: [actionId, now, feedbackId],
    },
  ], 'write');

  return actionId;
}

// ── Export types ─────────────────────────────────────────────────

export interface AgentInfo {
  name: string;
  status: 'active' | 'shadow' | 'suspended';
  model: string;
  description: string;
  capabilities: string[];
  frequencyTier: string;
  spent: number;
  cap: number;
  pct: number;
  budgetStatus: 'ok' | 'warn' | 'crit' | 'idle';
  pendingTasks: number;
  completedToday: number;
  currentTask: { id: string; description: string; lane: string } | null;
}

export interface BudgetAgent {
  name: string;
  spent: number;
  cap: number;
  pct: number;
  status: 'ok' | 'warn' | 'crit' | 'idle';
}
