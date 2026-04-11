import type { ReactNode } from 'react';

const STARTUP_COMMANDS = [
  { cmd: 'pnpm install', desc: 'Install workspace dependencies.' },
  { cmd: 'npx tsx --experimental-sqlite scripts/health-check.ts', desc: 'Verify secrets, database, backend selection, and executor availability.' },
  { cmd: 'npx tsx --experimental-sqlite scripts/start-daemon.ts', desc: 'Start the daemon, scheduler, runtime recovery, and dashboard integration.' },
  { cmd: 'npm run organism "status"', desc: 'Check whether the system is up and what is currently blocked.' },
];

const OPERATOR_COMMANDS = [
  { cmd: 'npm run organism "execute"', desc: 'Release pending work to the runner once the daemon is alive.' },
  { cmd: 'npm run organism "review tokens for good"', desc: 'Run a constrained project review for the recommended first pilot.' },
  { cmd: 'npm run organism "perspectives synapse"', desc: 'Run a perspective-only pass for Synapse when you want analysis without a high-risk execution path.' },
  { cmd: 'npm run organism "morning brief"', desc: 'Summarize what happened overnight.' },
  { cmd: 'npm run organism "palate stats"', desc: 'Inspect knowledge injection, cache savings, and source health.' },
];

const CAPABILITY_CARDS = [
  {
    title: 'Autonomous Execution',
    body: 'Organism can accept a goal, route it to the right agent, prepare the workspace, run code changes, verify build and test commands, and decide whether the result is ready to commit, push, open a PR, or deploy.',
  },
  {
    title: 'Controller-Owned Safety',
    body: 'Agents reason and propose. The controller owns privileged actions, policy checks, approvals, interrupts, and runtime events so execution is auditable and harder to derail with prompt drift.',
  },
  {
    title: 'Crash Recovery',
    body: 'Runs are durable. If the daemon stops mid-flight, Organism recovers orphaned runs, pauses or retries them deterministically, and resumes from run memory instead of starting from scratch.',
  },
  {
    title: 'Project Policies',
    body: 'Every project can declare its repo path, default branch, install/lint/test/build/deploy commands, allowed actions, blocked actions, budgets, deploy targets, and autonomy mode.',
  },
  {
    title: 'Runtime Visibility',
    body: 'The Runtime page shows goals, runs, steps, retries, approvals, interrupts, provider failures, backend/executor status, and rollout blockers in one place.',
  },
  {
    title: 'Cross-Executor Operation',
    body: 'The runtime can use Claude or Codex for engineering execution, and the model backend can prefer Claude CLI or Anthropic API depending on the environment.',
  },
];

const DASHBOARD_PAGES = [
  {
    title: 'Runtime',
    body: 'The main operational console. Use this to monitor live runs, approvals, retries, interrupts, rollout blockers, and whether a project is actually stabilizing.',
  },
  {
    title: 'Command',
    body: 'The launch surface for operators today. This is where new work is submitted from the website. The Runtime page is monitoring-first, not the primary submit form.',
  },
  {
    title: 'Review',
    body: 'The human review queue. Use this when the system pauses for a decision or when high-risk items require Rafael-level judgment.',
  },
  {
    title: 'System',
    body: 'Inspect agents, budgets, logs, and underlying health. This is the right place to sanity-check spend, capacity, and runtime noise.',
  },
  {
    title: 'Plan and Progress',
    body: 'Action items, goals, and planning views. Useful for understanding what Organism believes should happen next across projects.',
  },
];

const LIMITS = [
  'Organism is stronger mechanically, but it has not yet passed the 20 consecutive healthy-run graduation gate.',
  'In stabilization mode, purchases, human contact, and account creation remain blocked or approval-gated by project policy.',
  'The safest first live pilot is Tokens for Good. Synapse should start with review or validation work only because it is medical and currently has a very dirty worktree.',
  'The website is an operator cockpit, not the full brain. The daemon must be running locally for the dashboard to reflect real work.',
];

export default function GuidePage() {
  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-8 md:py-12">
      <section className="rounded-3xl border border-edge bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.10),_transparent_42%),linear-gradient(180deg,rgba(24,24,27,0.98),rgba(9,9,11,0.98))] px-6 py-8 md:px-8 md:py-10">
        <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-emerald-300">v2 manual</span>
          <span className="rounded-full border border-zinc-800 px-2.5 py-1">Local-first</span>
          <span className="rounded-full border border-zinc-800 px-2.5 py-1">Autonomous orchestration</span>
          <span className="rounded-full border border-zinc-800 px-2.5 py-1">Controller-owned actions</span>
        </div>

        <div className="mt-5 max-w-3xl">
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-zinc-50">
            Organism is a local-first autonomous operator for Rafael&apos;s projects.
          </h1>
          <p className="mt-4 text-base md:text-lg leading-8 text-zinc-300">
            It can route work, run specialist agents, edit code, verify commands, recover from failures, and move toward commit, PR, and deploy outcomes inside explicit project policy boundaries.
          </p>
          <p className="mt-3 text-sm leading-7 text-zinc-400">
            This guide is written for someone new to the system. It explains what Organism is, what it can do today, how to start it, where to click in the dashboard, and how to run the first safe pilot.
          </p>
        </div>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-3">
          <Metric title="Primary role" value="Autonomous orchestration" />
          <Metric title="Best operator view" value="Runtime + Command" />
          <Metric title="Current first pilot" value="Tokens for Good" />
        </div>
      </section>

      <Section title="What Organism Is">
        <P>
          Organism is not a single chatbot. It is a local runtime made of an orchestrator, a controller, a set of project-scoped agents, a persistent SQLite state store, durable run-memory files, and an operator dashboard.
        </P>
        <P>
          The orchestrator decides what kind of work is being requested. The controller owns sensitive actions such as verification, commit, push, PR, deploy, approvals, and interrupts. Agents do the reasoning and implementation work inside that boundary.
        </P>
        <P>
          The dashboard is the operator cockpit. It shows what the system is doing, what is blocked, what needs review, and whether a project is actually becoming safe to run more autonomously.
        </P>
      </Section>

      <Section title="What It Can Do Today">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {CAPABILITY_CARDS.map((card) => (
            <Concept key={card.title} title={card.title}>
              {card.body}
            </Concept>
          ))}
        </div>
      </Section>

      <Section title="How It Works">
        <div className="rounded-2xl border border-edge bg-zinc-950/80 p-5 md:p-6 space-y-4">
          <Step n={1} title="A goal is submitted">
            Work enters through the command flow, scripts, or automation. Organism creates or reuses a goal, assigns a workflow kind, and deduplicates repeated signals.
          </Step>
          <Step n={2} title="The orchestrator routes it">
            Routing respects the project roster, risk lane, workflow type, and current project policy. Organism no longer treats free-text tasks as its only source of truth.
          </Step>
          <Step n={3} title="An agent works inside run memory">
            The selected agent reads context, prior handoff state, facts, and recent command history from the durable run-memory files before it continues the mission.
          </Step>
          <Step n={4} title="The controller verifies and executes privileged steps">
            Build, test, commit, push, PR, deploy, approval creation, and interrupt handling are controller-owned. Agents may propose these actions, but they do not directly own them.
          </Step>
          <Step n={5} title="Runtime state stays visible and recoverable">
            Every run emits runtime events, records artifacts, and can be paused, retried, resumed, or recovered on daemon restart.
          </Step>
        </div>
      </Section>

      <Section title="How To Make It Function">
        <Split
          left={(
            <>
              <Subheading>One-Time Requirements</Subheading>
              <Checklist items={[
                'The repository is cloned locally.',
                'Dependencies are installed.',
                'The project policy exists in knowledge/projects/<project>/config.json.',
                'Required secrets are present for the chosen backend, code executor, GitHub access, and deploy targets.',
                'The local state directory is writable.',
              ]} />

              <Subheading>Core Environment Options</Subheading>
              <KeyValue label="Model backend" value="ORGANISM_MODEL_BACKEND=auto | claude-cli | anthropic-api" />
              <KeyValue label="Code executor" value="ORGANISM_CODE_EXECUTOR=auto | claude | codex" />
              <KeyValue label="State directory" value="%USERPROFILE%\\.organism\\state" />
            </>
          )}
          right={(
            <>
              <Subheading>Startup Commands</Subheading>
              <CommandTable items={STARTUP_COMMANDS} />
            </>
          )}
        />
      </Section>

      <Section title="Where To Click In The Website">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {DASHBOARD_PAGES.map((item) => (
            <Card key={item.title} title={item.title} icon=">">
              {item.body}
            </Card>
          ))}
        </div>
        <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
          <p className="text-sm text-amber-200">
            Important: the Runtime page is the best monitoring surface, but the Command page is still the clearest place to launch work from the website today.
          </p>
        </div>
      </Section>

      <Section title="First Safe Pilot">
        <div className="rounded-2xl border border-edge bg-zinc-950/80 p-5 md:p-6 space-y-4">
          <P>
            The recommended first live pilot is <span className="text-zinc-200 font-medium">Tokens for Good</span>.
            It is a better autonomy candidate than Synapse because its risk surface is lower for a first run and its repo is a safer place to verify controller behavior.
          </P>
          <Checklist items={[
            'Open the dashboard and go to Command.',
            'Select Tokens for Good in the project selector.',
            'Start with a constrained engineering or review command, not a deploy.',
            'Open Runtime in another tab and watch Live Runs, Interrupt Queue, and Autonomy Rollout.',
            'Treat the first run as PR-oriented validation, not as broad unattended shipping.',
          ]} />
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500 mb-2">Recommended examples</div>
            <code className="block text-sm text-emerald-400">npm run organism "review tokens for good"</code>
            <code className="block text-sm text-emerald-400 mt-2">npm run organism "execute"</code>
          </div>
        </div>
      </Section>

      <Section title="What Organism Is Allowed To Do">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Concept title="Routine autonomous actions">
            Edit code, run tests, run build commands, create or resume runs, update artifacts, create PR-oriented changes, and emit approvals or interrupts when policy requires a pause.
          </Concept>
          <Concept title="Approval-gated actions">
            Destructive migrations, cross-project actions, purchases, human contact, and account creation remain blocked or approval-gated depending on project policy and autonomy mode.
          </Concept>
          <Concept title="Review safeguards">
            Shadow agents do not quietly become active. Promotion still requires shadow evidence, and rollout health now surfaces gaps where active agents lack the required shadow history.
          </Concept>
          <Concept title="Failure safeguards">
            Provider overload, rate limits, auth failures, missing secrets, tool failures, and transport issues are all normalized into structured retry or pause behavior instead of becoming silent task chaos.
          </Concept>
        </div>
      </Section>

      <Section title="Operator Commands">
        <CommandTable items={OPERATOR_COMMANDS} />
      </Section>

      <Section title="Current Limits">
        <div className="rounded-2xl border border-edge bg-zinc-950/80 p-5 md:p-6">
          <Checklist items={LIMITS} tone="amber" />
        </div>
      </Section>

      <Section title="Plain-English Summary">
        <P>
          Organism is a local autonomous project operator. You start the daemon, watch the dashboard, submit or trigger work, and let the controller manage execution inside project policy boundaries.
        </P>
        <P>
          The safest first real run is Tokens for Good. Use the Command page to launch the task, use Runtime to supervise it, and treat the first pilot as validation that the loop can execute, recover, and stop cleanly.
        </P>
      </Section>

      <div className="text-center text-xs text-zinc-600 pt-8 border-t border-zinc-800/30">
        Organism v2 manual - autonomous orchestration, recovery, and policy-controlled execution
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="text-xl font-semibold text-zinc-100 mb-4">{title}</h2>
      {children}
    </section>
  );
}

function Split({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <div className="rounded-2xl border border-edge bg-zinc-950/80 p-5 md:p-6">{left}</div>
      <div className="rounded-2xl border border-edge bg-zinc-950/80 p-5 md:p-6">{right}</div>
    </div>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-sm md:text-[15px] text-zinc-400 leading-7 mb-3">{children}</p>;
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-edge bg-zinc-950/70 px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">{title}</div>
      <div className="mt-2 text-sm font-medium text-zinc-100">{value}</div>
    </div>
  );
}

function Card({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-edge bg-zinc-950/80 p-4">
      <span className="mt-0.5 w-6 shrink-0 text-center font-mono text-emerald-400">{icon}</span>
      <div>
        <div className="text-sm font-semibold text-zinc-100">{title}</div>
        <p className="mt-1 text-sm leading-6 text-zinc-400">{children}</p>
      </div>
    </div>
  );
}

function Concept({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-edge bg-zinc-950/80 p-4">
      <h3 className="text-sm font-semibold text-emerald-300">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-zinc-400">{children}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-xs font-semibold text-emerald-300">
        {n}
      </span>
      <div>
        <div className="text-sm font-medium text-zinc-100">{title}</div>
        <p className="mt-1 text-sm leading-6 text-zinc-400">{children}</p>
      </div>
    </div>
  );
}

function Subheading({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-500 mb-3">{children}</h3>;
}

function Checklist({ items, tone = 'emerald' }: { items: string[]; tone?: 'emerald' | 'amber' }) {
  const bulletTone = tone === 'amber' ? 'bg-amber-400' : 'bg-emerald-400';
  return (
    <div className="space-y-2.5">
      {items.map((item) => (
        <div key={item} className="flex items-start gap-3">
          <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${bulletTone}`} />
          <p className="text-sm leading-6 text-zinc-400">{item}</p>
        </div>
      ))}
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 mb-2">
      <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      <code className="mt-1 block text-xs text-emerald-300 break-all">{value}</code>
    </div>
  );
}

function CommandTable({ items }: { items: Array<{ cmd: string; desc: string }> }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-edge bg-zinc-950/80">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            <th className="px-4 py-3">Command</th>
            <th className="px-4 py-3">Purpose</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/50">
          {items.map((item) => (
            <tr key={item.cmd}>
              <td className="px-4 py-3 align-top">
                <code className="text-xs md:text-sm text-emerald-300">{item.cmd}</code>
              </td>
              <td className="px-4 py-3 text-sm leading-6 text-zinc-400">{item.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
