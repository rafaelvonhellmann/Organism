export default function GuidePage() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-8 md:py-12">
      {/* Hero */}
      <div className="text-center mb-12">
        <div className="text-5xl mb-4">🧬</div>
        <h1 className="text-2xl md:text-3xl font-bold text-zinc-100 mb-3">
          Welcome to Organism
        </h1>
        <p className="text-zinc-400 max-w-lg mx-auto">
          A living knowledge system that reviews, researches, and evolves understanding of your projects through parallel domain perspectives.
        </p>
      </div>

      {/* How it works */}
      <section className="mb-12">
        <h2 className="text-lg font-semibold text-zinc-200 mb-4">How it works</h2>
        <div className="grid gap-4">
          {/* Step cards */}
          <div className="bg-surface rounded-xl border border-edge p-5">
            <div className="flex items-start gap-4">
              <span className="text-2xl">1️⃣</span>
              <div>
                <h3 className="font-semibold text-zinc-200 text-sm mb-1">Onboard your project</h3>
                <p className="text-sm text-zinc-400">Answer 10 questions about your project. Organism generates a VISION.md constitutional document and configures itself.</p>
                <code className="inline-block mt-2 px-3 py-1.5 bg-zinc-800/60 rounded-md text-xs text-emerald-400 font-mono">
                  npm run organism &quot;onboard synapse&quot;
                </code>
              </div>
            </div>
          </div>

          <div className="bg-surface rounded-xl border border-edge p-5">
            <div className="flex items-start gap-4">
              <span className="text-2xl">2️⃣</span>
              <div>
                <h3 className="font-semibold text-zinc-200 text-sm mb-1">Run perspective reviews</h3>
                <p className="text-sm text-zinc-400">14 domain perspectives (Strategy, Engineering, Legal, Marketing, etc.) analyse your project in parallel. Results land in your Obsidian vault as linked markdown files.</p>
                <code className="inline-block mt-2 px-3 py-1.5 bg-zinc-800/60 rounded-md text-xs text-emerald-400 font-mono">
                  npm run organism &quot;perspectives synapse&quot;
                </code>
              </div>
            </div>
          </div>

          <div className="bg-surface rounded-xl border border-edge p-5">
            <div className="flex items-start gap-4">
              <span className="text-2xl">3️⃣</span>
              <div>
                <h3 className="font-semibold text-zinc-200 text-sm mb-1">Research the landscape</h3>
                <p className="text-sm text-zinc-400">Organism searches the internet for competitors, market context, and technical documentation. Research is cached for 7 days.</p>
                <code className="inline-block mt-2 px-3 py-1.5 bg-zinc-800/60 rounded-md text-xs text-emerald-400 font-mono">
                  npm run organism &quot;research synapse competitors&quot;
                </code>
              </div>
            </div>
          </div>

          <div className="bg-surface rounded-xl border border-edge p-5">
            <div className="flex items-start gap-4">
              <span className="text-2xl">4️⃣</span>
              <div>
                <h3 className="font-semibold text-zinc-200 text-sm mb-1">Watch it evolve</h3>
                <p className="text-sm text-zinc-400">Over time, Organism learns which perspectives produce value for each project. High-fitness perspectives get prioritised. Useless ones go dormant. Darwinian selection at work.</p>
                <code className="inline-block mt-2 px-3 py-1.5 bg-zinc-800/60 rounded-md text-xs text-emerald-400 font-mono">
                  npm run organism &quot;fitness synapse&quot;
                </code>
              </div>
            </div>
          </div>

          <div className="bg-surface rounded-xl border border-edge p-5">
            <div className="flex items-start gap-4">
              <span className="text-2xl">5️⃣</span>
              <div>
                <h3 className="font-semibold text-zinc-200 text-sm mb-1">Distill knowledge</h3>
                <p className="text-sm text-zinc-400">After several reviews, condense everything learned into a compact reference document. Future reviews automatically use this context, reducing token costs.</p>
                <code className="inline-block mt-2 px-3 py-1.5 bg-zinc-800/60 rounded-md text-xs text-emerald-400 font-mono">
                  npm run organism &quot;distill synapse&quot;
                </code>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Dashboard pages */}
      <section className="mb-12">
        <h2 className="text-lg font-semibold text-zinc-200 mb-4">Dashboard pages</h2>
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-edge/50">
            <span className="text-lg w-8 text-center">◎</span>
            <div>
              <span className="text-sm font-medium text-zinc-200">Overview</span>
              <span className="text-xs text-zinc-500 ml-2">System metrics, recent activity, perspective status</span>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-edge/50">
            <span className="text-lg w-8 text-center">◇</span>
            <div>
              <span className="text-sm font-medium text-zinc-200">Perspectives</span>
              <span className="text-xs text-zinc-500 ml-2">All 14 domain lenses with fitness scores and keywords</span>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-edge/50">
            <span className="text-lg w-8 text-center">≡</span>
            <div>
              <span className="text-sm font-medium text-zinc-200">Tasks</span>
              <span className="text-xs text-zinc-500 ml-2">Task queue with filters by status, lane, and perspective</span>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-edge/50">
            <span className="text-lg w-8 text-center">◈</span>
            <div>
              <span className="text-sm font-medium text-zinc-200">Budget</span>
              <span className="text-xs text-zinc-500 ml-2">Per-perspective daily spend with caps and alerts</span>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-edge/50">
            <span className="text-lg w-8 text-center">↗</span>
            <div>
              <span className="text-sm font-medium text-zinc-200">Evolution</span>
              <span className="text-xs text-zinc-500 ml-2">Darwinian fitness scores — which perspectives thrive per project</span>
            </div>
          </div>
        </div>
      </section>

      {/* Key concepts */}
      <section className="mb-12">
        <h2 className="text-lg font-semibold text-zinc-200 mb-4">Key concepts</h2>
        <div className="grid gap-3">
          <div className="bg-surface rounded-xl border border-edge p-4">
            <h3 className="text-sm font-semibold text-emerald-400 mb-1">Perspectives</h3>
            <p className="text-xs text-zinc-400">Domain lenses (Strategy, Engineering, Legal, etc.) that analyse your project from different angles. Each is a system prompt that runs in parallel via the Claude CLI — no API credits consumed.</p>
          </div>
          <div className="bg-surface rounded-xl border border-edge p-4">
            <h3 className="text-sm font-semibold text-emerald-400 mb-1">Fitness</h3>
            <p className="text-xs text-zinc-400">Each perspective earns a fitness score per project based on quality, your ratings, and usage. High-fitness perspectives are prioritised. Low-fitness ones go dormant. The organism evolves.</p>
          </div>
          <div className="bg-surface rounded-xl border border-edge p-4">
            <h3 className="text-sm font-semibold text-emerald-400 mb-1">Obsidian Vault</h3>
            <p className="text-xs text-zinc-400">All output lands in your Obsidian vault as plain markdown with YAML frontmatter and [[wikilinks]]. File over app — your knowledge is yours, in universal formats, inspectable and portable.</p>
          </div>
          <div className="bg-surface rounded-xl border border-edge p-4">
            <h3 className="text-sm font-semibold text-emerald-400 mb-1">Distillation</h3>
            <p className="text-xs text-zinc-400">After multiple reviews, Organism condenses accumulated knowledge into a compact summary. Future perspectives use this distilled context, reducing token usage and improving accuracy over time.</p>
          </div>
        </div>
      </section>

      {/* All commands reference */}
      <section className="mb-12">
        <h2 className="text-lg font-semibold text-zinc-200 mb-4">All commands</h2>
        <div className="bg-surface rounded-xl border border-edge overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-xs text-zinc-500">
                <th className="text-left px-4 py-2.5">Command</th>
                <th className="text-left px-4 py-2.5">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge/30 font-mono text-xs">
              <tr><td className="px-4 py-2.5 text-emerald-400">perspectives &lt;project&gt;</td><td className="px-4 py-2.5 text-zinc-400">Full parallel perspective review → Obsidian vault</td></tr>
              <tr><td className="px-4 py-2.5 text-emerald-400">onboard &lt;project&gt;</td><td className="px-4 py-2.5 text-zinc-400">Interview → VISION.md + config.json</td></tr>
              <tr><td className="px-4 py-2.5 text-emerald-400">research &lt;project&gt; competitors</td><td className="px-4 py-2.5 text-zinc-400">Competitor analysis → vault</td></tr>
              <tr><td className="px-4 py-2.5 text-emerald-400">research &lt;project&gt; market</td><td className="px-4 py-2.5 text-zinc-400">Market landscape → vault</td></tr>
              <tr><td className="px-4 py-2.5 text-emerald-400">fitness &lt;project&gt;</td><td className="px-4 py-2.5 text-zinc-400">View Darwinian perspective fitness scores</td></tr>
              <tr><td className="px-4 py-2.5 text-emerald-400">distill &lt;project&gt;</td><td className="px-4 py-2.5 text-zinc-400">Condense all reviews into knowledge summary</td></tr>
              <tr><td className="px-4 py-2.5 text-emerald-400">review synapse</td><td className="px-4 py-2.5 text-zinc-400">Legacy 20-agent review (old system)</td></tr>
              <tr><td className="px-4 py-2.5 text-emerald-400">status</td><td className="px-4 py-2.5 text-zinc-400">Show system health</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Footer */}
      <div className="text-center text-xs text-zinc-600 pt-4 border-t border-edge/30">
        Organism v0.2.0 — Living Knowledge System
      </div>
    </div>
  );
}
