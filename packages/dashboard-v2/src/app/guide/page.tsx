import type { ReactNode } from 'react';

const STARTUP_COMMANDS = [
  { cmd: 'pnpm install', desc: 'Install workspace dependencies.' },
  { cmd: 'npx tsx --experimental-sqlite scripts/ensure-services.ts', desc: 'Start the local dashboard bridge, daemon, and supporting services together.' },
  { cmd: 'npm run organism "status"', desc: 'Check what is running, what is blocked, and whether the local runtime is healthy.' },
];

const OPERATOR_COMMANDS = [
  { cmd: 'npm run organism "review tokens-for-good"', desc: 'Inspect project state and let Organism choose the next safe work.' },
  { cmd: 'npm run organism "implement the next safest useful task for tokens-for-good"', desc: 'Move a project forward with one bounded implementation step.' },
  { cmd: 'npm run organism "validate tokens-for-good current state"', desc: 'Verify the latest work and decide whether it is clean, safe, and complete.' },
];

const CAPABILITY_CARDS = [
  {
    title: 'Controller-Owned Start / Continue',
    body: 'The browser no longer decides the next workflow. Start / Continue now asks the controller to inspect current state and choose whether to continue, review, implement, or validate.',
  },
  {
    title: 'One Runtime, Three Core Actions',
    body: 'The operator model is intentionally small now: Review, Implement, and Validate. Everything else is internal system behavior, not something you should need to memorize.',
  },
  {
    title: 'Local-First Control Plane',
    body: 'Organism is powered by a local daemon plus a local dashboard bridge. The website becomes an operator shell over that local runtime, especially when remote database writes are restricted.',
  },
  {
    title: 'Automatic Next Step Selection',
    body: 'After a clean review, Organism should choose the next safe task. After a clean implementation, it should create validation work automatically instead of waiting for more operator clicks.',
  },
  {
    title: 'Project-Scoped Safety',
    body: 'Each project declares what is safe to do, what is blocked, and how aggressively autonomy can proceed. Synapse is stricter than Tokens for Good because it is the higher-risk project.',
  },
  {
    title: 'OpenAI-First Runtime',
    body: 'OpenAI is the default company runtime now. Codex CLI is primary and OpenAI API is fallback. Legacy Anthropic paths are optional and should not be the normal operating path.',
  },
  {
    title: 'Recoverable State',
    body: 'Runs, retries, and approvals are durable. If the daemon stops, Organism should recover state instead of quietly forgetting what it was doing.',
  },
  {
    title: 'Project Memory Snapshot',
    body: 'Each launch now captures a compact project memory snapshot with recent goals, blockers, and useful outputs so the next step starts from fresh project context instead of rediscovering everything.',
  },
];

const WINDSURF_ADAPTATIONS = [
  {
    principle: 'One obvious action',
    windsurf: 'Windsurf feels fast because the normal path is one continuous flow, not a menu of orchestration concepts.',
    organism: 'Organism now centers Start / Continue and moves workflow choice into the controller instead of the browser.',
  },
  {
    principle: 'Workspace memory',
    windsurf: 'Windsurf keeps local context and recent work close to the agent experience.',
    organism: 'Organism now captures a compact project memory snapshot on every launch so reviews and implementations inherit recent blockers and outputs.',
  },
  {
    principle: 'Low-friction continuation',
    windsurf: 'The tool naturally resumes the current thread of work instead of asking the operator to classify the next step every time.',
    organism: 'Start / Continue now prefers continuing live work, then falls back to review, validate, or implement based on controller state.',
  },
  {
    principle: 'Less operator jargon',
    windsurf: 'The product does not ask the user to think in internal lifecycle labels.',
    organism: 'Operator-facing canary/control-plane wording is being collapsed into review, implement, validate, and clear blocker language.',
  },
];

const DASHBOARD_PAGES = [
  {
    title: 'Launch',
    body: 'The main operator surface. Use Start / Continue for the normal path. Use Manual Override only when you want to force Review, Implement, or Validate directly.',
  },
  {
    title: 'Runtime',
    body: 'Use this to answer two questions quickly: what is Organism doing now, and what will it try next automatically.',
  },
  {
    title: 'Review',
    body: 'This is only for human decisions and paused items. If nothing needs judgment, you should not need to sit here.',
  },
  {
    title: 'Plan',
    body: 'The project-level view of what matters next. It should reflect current project intent, not random old task noise.',
  },
  {
    title: 'System',
    body: 'Check daemon health, budgets, agent posture, and whether the local bridge or sync layer is degraded.',
  },
];

const LIMITS = [
  'A project now targets 3 healthy goals, not 20. The goal is to prove bounded autonomy earlier and more honestly.',
  'Synapse is still read-only or validation-first. Protected grading, benchmark, rubric, and medical-content paths should remain blocked from broad autonomous implementation.',
  'The hosted dashboard can lag when remote writes are blocked. In that situation, the local daemon bridge is the source of truth.',
  'If Start / Continue fails with a fetch error, the first thing to check is whether the local bridge on port 7391 is running.',
];

const TROUBLESHOOTING = [
  'If Launch says "failed to fetch", restart services with `npx tsx --experimental-sqlite scripts/ensure-services.ts`.',
  'If the daemon looks inactive but tasks appear in progress, check Runtime first and then `npm run organism "status"` locally.',
  'If the website looks stale, hard refresh once. The local runtime is usually more truthful than hosted history when remote writes are blocked.',
  'If a project seems stuck, prefer Review or Validate over vague commands. Organism routes explicit workflow names much better than fuzzy text.',
];

export default function GuidePage() {
  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-8 md:py-12">
      <section className="rounded-3xl border border-edge bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.10),_transparent_42%),linear-gradient(180deg,rgba(24,24,27,0.98),rgba(9,9,11,0.98))] px-6 py-8 md:px-8 md:py-10">
        <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-emerald-300">manual</span>
          <span className="rounded-full border border-zinc-800 px-2.5 py-1">local-first</span>
          <span className="rounded-full border border-zinc-800 px-2.5 py-1">review / implement / validate</span>
          <span className="rounded-full border border-zinc-800 px-2.5 py-1">3 healthy goals</span>
        </div>

        <div className="mt-5 max-w-3xl">
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-zinc-50">
            Organism is a local-first project operator with a deliberately smaller workflow.
          </h1>
          <p className="mt-4 text-base md:text-lg leading-8 text-zinc-300">
            The goal now is not to teach you a large control panel. The goal is to make one safe action work reliably, let Organism continue automatically, and surface clear blockers when it cannot.
          </p>
          <p className="mt-3 text-sm leading-7 text-zinc-400">
            The normal operator path is simple: start the local services, open Launch, press Start / Continue, then watch Runtime.
          </p>
        </div>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-3">
          <Metric title="Primary launch path" value="Start / Continue" />
          <Metric title="Core workflows" value="Review, Implement, Validate" />
          <Metric title="Current posture" value="Bounded autonomy" />
        </div>
      </section>

      <Section title="What Organism Is">
        <P>
          Organism is not just a website. It is a local daemon, a local dashboard bridge, a project policy system, and a set of specialist agents operating inside a controller-owned safety layer.
        </P>
        <P>
          The website is the cockpit. The local runtime is the actual engine. When the two disagree, the local runtime is usually the truth.
        </P>
      </Section>

      <Section title="The Simplified Workflow">
        <div className="rounded-2xl border border-edge bg-zinc-950/80 p-5 md:p-6 space-y-4">
          <Step n={1} title="Review">
            Understand the current project state and decide the next safest useful work.
          </Step>
          <Step n={2} title="Implement">
            Execute one bounded improvement. Organism should keep this narrow and safe.
          </Step>
          <Step n={3} title="Validate">
            Check whether the last change is clean, complete, and ready for the next step.
          </Step>
          <P>
            Everything else such as retries, approvals, fallbacks, recovery, and follow-up planning is internal control-plane behavior. You should not need to think in terms like canary, execute, autonomy cycle, or special launch presets anymore.
          </P>
        </div>
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

      <Section title="What We Adapted From Windsurf">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {WINDSURF_ADAPTATIONS.map((item) => (
            <div key={item.principle} className="rounded-2xl border border-edge bg-zinc-950/80 p-4">
              <h3 className="text-sm font-semibold text-emerald-300">{item.principle}</h3>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                <span className="text-zinc-300 font-medium">Windsurf:</span> {item.windsurf}
              </p>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                <span className="text-zinc-300 font-medium">Organism:</span> {item.organism}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="How To Start It">
        <Split
          left={(
            <>
              <Subheading>Normal Startup</Subheading>
              <CommandTable items={STARTUP_COMMANDS} />
            </>
          )}
          right={(
            <>
              <Subheading>What Healthy Looks Like</Subheading>
              <Checklist items={[
                'Launch submits work without a fetch error.',
                'Runtime shows a current step and a next automatic step.',
                'The daemon is alive locally.',
                'A project can finish a whole goal, not just a loose review subtask.',
              ]} />
            </>
          )}
        />
      </Section>

      <Section title="Where To Click">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {DASHBOARD_PAGES.map((item) => (
            <Card key={item.title} title={item.title} icon=">">
              {item.body}
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Recommended Commands">
        <CommandTable items={OPERATOR_COMMANDS} />
      </Section>

      <Section title="Project Rules Right Now">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Concept title="Tokens for Good">
            This is still the best autonomy proving ground. It is where we should expect clean review, implementation, and validation loops first.
          </Concept>
          <Concept title="Synapse">
            Keep this read-only or validation-first until the safe lane proves itself. Medical-risk and grading-adjacent surfaces should remain tightly gated.
          </Concept>
          <Concept title="Organism on itself">
            Self-audit is valuable and should continue, but bounded self-improvement is the right model, not uncontrolled self-rewriting.
          </Concept>
          <Concept title="Healthy goals">
            A healthy goal is a whole mission that moves a project forward, not an individual subtask. The rollout ladder is now based on 3 healthy goals, not 20 runs.
          </Concept>
        </div>
      </Section>

      <Section title="If Launch Says Failed To Fetch">
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-5 md:p-6">
          <Checklist items={TROUBLESHOOTING} tone="amber" />
        </div>
      </Section>

      <Section title="Current Limits">
        <div className="rounded-2xl border border-edge bg-zinc-950/80 p-5 md:p-6">
          <Checklist items={LIMITS} tone="amber" />
        </div>
      </Section>

      <Section title="Plain-English Summary">
        <P>
          Start the local services, use Start / Continue for the project you care about, and let Organism handle the next safe step automatically.
        </P>
        <P>
          If it cannot proceed, Runtime should tell you one clear blocker. If Launch says fetch failed, treat the local bridge as the first thing to inspect or restart.
        </P>
      </Section>

      <div className="text-center text-xs text-zinc-600 pt-8 border-t border-zinc-800/30">
        Organism manual - simplified local-first workflow
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
