import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getSystemStatus } from '../../core/src/orchestrator.js';
import { getSpendSummary, getSystemSpend } from '../../core/src/budget.js';
import { getPendingTasks, getDeadLetterTasks } from '../../core/src/task-queue.js';
import { readRecentForAgent } from '../../core/src/audit.js';

const PORT = parseInt(process.env.DASHBOARD_PORT ?? '7391');

// Dashboard HTML — single-page auto-refreshing status board
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="5">
<title>Organism Dashboard</title>
<style>
  body { font-family: monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 4px; }
  .subtitle { color: #8b949e; font-size: 12px; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
  th { color: #8b949e; text-align: left; padding: 4px 12px; border-bottom: 1px solid #21262d; }
  td { padding: 4px 12px; border-bottom: 1px solid #161b22; }
  .ok { color: #3fb950; }
  .warn { color: #d29922; }
  .crit { color: #f85149; }
  .idle { color: #8b949e; }
  .section { color: #58a6ff; margin: 16px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; }
  .alert { background: #2d1b1b; border: 1px solid #f85149; border-radius: 4px; padding: 8px 12px; margin: 4px 0; }
  pre { background: #161b22; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 11px; }
</style>
</head>
<body>
<h1>Organism</h1>
<div class="subtitle" id="ts">Loading...</div>
<div id="content">Loading dashboard...</div>
<script>
  document.getElementById('ts').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
</script>
</body>
</html>`;

function buildDashboardData(projectFilter?: string) {
  try {
    const status = getSystemStatus(projectFilter);
    const spend = getSpendSummary(undefined, projectFilter);
    const systemTotal = getSystemSpend();
    const pending = getPendingTasks(undefined, projectFilter);
    const deadLetters = getDeadLetterTasks();

    return {
      systemTotal: systemTotal.toFixed(4),
      systemCap: process.env.SYSTEM_DAILY_CAP_USD ?? '50',
      pendingCount: pending.length,
      deadLetterCount: deadLetters.length,
      projectFilter: projectFilter ?? 'all',
      alerts: status.alerts,
      agents: spend.map((s) => ({
        name: s.agent,
        spent: `$${s.spent.toFixed(4)}`,
        cap: `$${s.cap.toFixed(2)}`,
        pct: s.pct.toFixed(0),
        status: s.pct > 90 ? 'crit' : s.pct > 80 ? 'warn' : s.pct > 0 ? 'ok' : 'idle',
      })),
      pending: pending.slice(0, 10).map((t) => ({
        id: t.id.slice(0, 8),
        agent: t.agent,
        lane: t.lane,
        project: t.projectId ?? 'organism',
        description: t.description.slice(0, 60),
      })),
      deadLetters: deadLetters.slice(0, 5).map((t) => ({
        id: t.id.slice(0, 8),
        agent: t.agent,
        project: t.projectId ?? 'organism',
        description: t.description.slice(0, 60),
        error: t.error,
      })),
    };
  } catch (err) {
    return { error: String(err) };
  }
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/status')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const project = url.searchParams.get('project') ?? undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildDashboardData(project), null, 2));
    return;
  }

  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[Dashboard] Running at http://localhost:${PORT}`);
  console.log(`[Dashboard] API: http://localhost:${PORT}/api/status`);
});

// Print status to terminal every 30 seconds
setInterval(() => {
  const data = buildDashboardData();
  if ('error' in data) {
    console.error(`[Dashboard] Error: ${data.error}`);
    return;
  }
  console.log(`\n[Dashboard] ${new Date().toISOString()}`);
  console.log(`  System spend: $${data.systemTotal} / $${data.systemCap}`);
  console.log(`  Pending tasks: ${data.pendingCount} | Dead letters: ${data.deadLetterCount}`);
  if (data.alerts.length > 0) {
    console.log(`  ALERTS: ${data.alerts.join(' | ')}`);
  }
  for (const agent of data.agents) {
    if (agent.status !== 'idle') {
      console.log(`  ${agent.name}: ${agent.spent} / ${agent.cap} (${agent.pct}%)`);
    }
  }
}, 30_000);

export default server;
