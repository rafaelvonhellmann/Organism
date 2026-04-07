export default function GuidePage() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-8 md:py-12">
      {/* Hero */}
      <div className="text-center mb-12">
        <h1 className="text-2xl md:text-3xl font-bold text-zinc-100 mb-3">
          Organism Manual
        </h1>
        <p className="text-zinc-400 max-w-lg mx-auto">
          A living knowledge system that reviews, researches, and evolves your projects through parallel domain perspectives. This is your complete guide.
        </p>
      </div>

      {/* What is Organism */}
      <Section title="What is Organism?">
        <P>Organism is your AI operations team. It runs 15+ domain perspectives (Strategy, Engineering, Legal, Marketing, etc.) in parallel against your projects. Each perspective analyses the project from its domain, produces findings, and evolves over time based on what&apos;s useful.</P>
        <P>Output is plain markdown in your Obsidian vault. All knowledge is yours, in universal formats. Files over apps.</P>
        <P>You are the human-in-the-loop: Organism proposes, you approve. 30 minutes a day is all it takes.</P>
      </Section>

      {/* Dashboard */}
      <Section title="The Dashboard">
        <Card title="Inbox" icon=">">
          Your review queue. Agent assessments that need your decision. Approve, dismiss, or reply. HIGH priority items are flagged. LOW items can be batch-approved in one click. Browser notifications alert you when new HIGH items arrive.
        </Card>
        <Card title="Plan" icon="!">
          Kanban-style roadmap with 5 time horizons (This Week / 15 Days / 1 Month / 3 Months / 6 Months). Each perspective has a card showing what&apos;s planned for that horizon, plus recent task activity. Scroll horizontally to see the full timeline.
        </Card>
        <Card title="Insights" icon="&">
          The &quot;investor letter&quot; for your project. Traffic light status (red/amber/green), executive synthesis, findings grouped by domain (Strategy, Technology, Finance, etc.), and review history. Honest, unfiltered assessment of where things stand.
        </Card>
        <Card title="System" icon="#">
          Under the hood. Four tabs: Budget (daily spend per agent), Agents (status and model), Knowledge (Palate sources and injection stats), Logs (audit trail). Check this weekly, not daily.
        </Card>
        <Card title="Command" icon="$">
          Terminal in the browser. Type any Organism command without opening PowerShell. Quick action buttons for common commands. Command history with status tracking. Results appear when the local daemon processes them (~60 seconds).
        </Card>
      </Section>

      {/* Core Loop */}
      <Section title="The Core Loop">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
          <Step n={1} title="Agent reviews your project">Each perspective runs independently, producing findings from its domain expertise.</Step>
          <Step n={2} title="Quality gate">The quality-agent reviews every output. If it finds critical issues, it triggers a revision (max 2 rounds, $2 cap).</Step>
          <Step n={3} title="Codex review">Code-aware review checks for technical accuracy and implementation feasibility.</Step>
          <Step n={4} title="Your decision">HIGH items land in your Inbox. LOW items are auto-approved if quality passes. You approve, dismiss, or request changes.</Step>
          <Step n={5} title="Knowledge compounds">Approved findings feed into the Obsidian vault. The Palate distills knowledge sources for future reviews. Fitness scores evolve.</Step>
        </div>
      </Section>

      {/* Key Systems */}
      <Section title="Key Systems">
        <Concept title="Palate (Knowledge Injection)">
          When a task matches a capability in the registry, the Palate reads its declared knowledge sources, distills them to ~30% via Haiku (cached), and injects the distilled content into the task. Agents get relevant context automatically. 66% token savings measured.
        </Concept>
        <Concept title="Darwinian Evolution">
          Every perspective has a fitness score per project. High ratings boost fitness. Low ratings penalize. Perspectives unused for 30+ days decay. Below 0.2 fitness = auto-suspended. The organism prunes what doesn&apos;t work.
        </Concept>
        <Concept title="Self-Scheduling">
          After each review, agents recommend when their next review should be (1-30 days). The review script skips agents that aren&apos;t due. Routine runs drop from 20 agents to ~8-10, cutting cost ~50%.
        </Concept>
        <Concept title="Auto-Approve">
          LOW-lane tasks that pass quality gates are auto-approved without human review. Only HIGH items and items with critical findings reach your Inbox. Cuts the queue from ~74 to ~10-15 items.
        </Concept>
        <Concept title="Risk Lanes">
          Every task is classified: LOW (50%, auto-ship after quality), MEDIUM (35%, quality + codex review), HIGH (15%, full review pipeline including your approval). Security and legal only trigger when their domain keywords are present.
        </Concept>
        <Concept title="Budget System">
          Each agent has a daily cap. Per-task hard caps prevent runaway costs ($3 for security-audit, $2 for product-manager). Overspend is detected, logged, and the task is clamped. Max 2 revision loops per task.
        </Concept>
      </Section>

      {/* Commands Reference */}
      <Section title="All Commands">
        <p className="text-xs text-zinc-500 mb-3">Use these in the Command page or the terminal (<code className="text-emerald-400">npm run organism &quot;...&quot;</code>)</p>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                <th className="text-left px-4 py-2.5">Command</th>
                <th className="text-left px-4 py-2.5">What it does</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/30 font-mono text-xs">
              <Cmd cmd="review synapse" desc="Full 20-agent review with quality gates" />
              <Cmd cmd="perspectives synapse" desc="Parallel perspective review, output to Obsidian vault" />
              <Cmd cmd="onboard <project>" desc="Interview + VISION.md + config generation" />
              <Cmd cmd="research <project> competitors" desc="Competitor analysis from web search" />
              <Cmd cmd="research <project> market" desc="Market landscape research" />
              <Cmd cmd="distill <project>" desc="Condense all reviews into knowledge summary" />
              <Cmd cmd="fitness <project>" desc="View Darwinian perspective fitness scores" />
              <Cmd cmd="execute" desc="Dispatch pending tasks to agents" />
              <Cmd cmd="deploy" desc="Start daemon + dashboard + all services" />
              <Cmd cmd="stop" desc="Shut down all services" />
              <Cmd cmd="status" desc="System health check" />
              <Cmd cmd="morning brief" desc="Daily summary of what happened overnight" />
              <Cmd cmd="palate list" desc="Show registered knowledge sources + fitness" />
              <Cmd cmd="palate stats" desc="Injection telemetry (tokens, savings, cache)" />
              <Cmd cmd="palate add <path> tags" desc="Register a knowledge source (unapproved)" />
              <Cmd cmd="palate approve <id>" desc="Approve source for injection" />
              <Cmd cmd="rate <page> <1-5>" desc="Rate a wiki page (feeds Darwinian fitness)" />
            </tbody>
          </table>
        </div>
      </Section>

      {/* Cost Guide */}
      <Section title="Cost Guide">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <div className="space-y-2 text-sm text-zinc-400">
            <div className="flex justify-between"><span>Full review (all agents)</span><span className="text-amber-400">~$15-20</span></div>
            <div className="flex justify-between"><span>Routine review (self-scheduled)</span><span className="text-amber-400">~$8-12</span></div>
            <div className="flex justify-between"><span>Perspective run</span><span className="text-amber-400">~$3-5</span></div>
            <div className="flex justify-between"><span>Single agent task</span><span className="text-amber-400">~$0.10-0.50</span></div>
            <div className="flex justify-between"><span>Palate distillation (cached)</span><span className="text-amber-400">~$0.01</span></div>
            <div className="flex justify-between border-t border-zinc-800 pt-2"><span className="text-zinc-300">Daily budget cap</span><span className="text-zinc-300">$50</span></div>
          </div>
        </div>
      </Section>

      {/* Footer */}
      <div className="text-center text-xs text-zinc-600 pt-8 border-t border-zinc-800/30">
        Organism v0.3.0 — Living Knowledge System
      </div>
    </div>
  );
}

// ── Reusable components ────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold text-zinc-200 mb-4">{title}</h2>
      {children}
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-zinc-400 mb-3 leading-relaxed">{children}</p>;
}

function Card({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-zinc-900 border border-zinc-800/50 mb-2">
      <span className="text-emerald-400 font-mono font-bold w-6 text-center shrink-0">{icon}</span>
      <div>
        <span className="text-sm font-semibold text-zinc-200">{title}</span>
        <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 rounded-full w-6 h-6 flex items-center justify-center shrink-0">{n}</span>
      <div>
        <span className="text-sm font-medium text-zinc-200">{title}</span>
        <p className="text-xs text-zinc-400 mt-0.5">{children}</p>
      </div>
    </div>
  );
}

function Concept({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-2">
      <h3 className="text-sm font-semibold text-emerald-400 mb-1">{title}</h3>
      <p className="text-xs text-zinc-400 leading-relaxed">{children}</p>
    </div>
  );
}

function Cmd({ cmd, desc }: { cmd: string; desc: string }) {
  return (
    <tr>
      <td className="px-4 py-2.5 text-emerald-400">{cmd}</td>
      <td className="px-4 py-2.5 text-zinc-400">{desc}</td>
    </tr>
  );
}
