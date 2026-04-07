import * as fs from 'fs';
import * as path from 'path';
import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import { listSources, getApprovedSourcesByTags } from '../../packages/core/src/palate-sources.js';

const WIKI_DIR = path.resolve(process.cwd(), 'knowledge/palate/wiki');
const MAX_PAGE_WORDS = 3000;

const SYSTEM = `You are a wiki writer for the Organism knowledge system. You synthesize source documents into clear, reference-quality wiki pages.

Rules:
- Write in markdown with clear headings
- Include [[wikilinks]] to related pages where relevant
- Cite sources inline: [source: filename.md]
- Be authoritative and concise — this is a reference, not a tutorial
- If information conflicts between sources, note the discrepancy
- End each page with a "Sources" section listing all documents used
- No preamble. Start directly with the page title as an H1.`;

export default class PalateWikiAgent extends BaseAgent {
  constructor() {
    super({
      name: 'palate-wiki',
      model: 'sonnet',
      capability: {
        id: 'knowledge.wiki',
        owner: 'palate-wiki',
        collaborators: [],
        reviewerLane: 'LOW',
        description: 'Maintains the living wiki from sources and review findings',
        status: 'shadow',
        model: 'sonnet',
        frequencyTier: 'weekly',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const domain = (input?.domain as string) ?? this.inferDomain(task.description);

    // Gather all approved sources for this domain
    const sources = getApprovedSourcesByTags([domain]);
    const allSources = listSources();

    // Read source content
    const root = process.cwd();
    const sourceContents: { name: string; content: string }[] = [];
    for (const s of sources.length > 0 ? sources : allSources.filter((s) => s.approved)) {
      try {
        const content = fs.readFileSync(path.resolve(root, s.localPath), 'utf8');
        sourceContents.push({ name: path.basename(s.localPath), content });
      } catch { /* skip missing files */ }
    }

    // Read existing wiki page if it exists (for updates)
    const pagePath = path.join(WIKI_DIR, `${domain}.md`);
    let existingPage = '';
    try {
      existingPage = fs.readFileSync(pagePath, 'utf8');
    } catch { /* new page */ }

    const prompt = `${existingPage ? 'Update' : 'Write'} the wiki page for domain: "${domain}"

${existingPage ? `Current page:\n---\n${existingPage}\n---\n` : ''}
Source documents:
${sourceContents.map((s) => `### ${s.name}\n${s.content}`).join('\n\n---\n\n')}

${sourceContents.length === 0 ? 'No source documents available. Write a stub page with known information from your training data, clearly marked as needing sources.' : ''}

Write a comprehensive wiki page for the "${domain}" domain. If the page exceeds ${MAX_PAGE_WORDS} words, split into sub-topics and note which sub-pages should be created.`;

    const result = await callModelUltra(prompt, 'sonnet', SYSTEM);

    // Write the wiki page
    if (!fs.existsSync(WIKI_DIR)) fs.mkdirSync(WIKI_DIR, { recursive: true });
    fs.writeFileSync(pagePath, result.text, 'utf8');

    // Check if page is too long and needs splitting
    const wordCount = result.text.split(/\s+/).length;
    const needsSplit = wordCount > MAX_PAGE_WORDS;

    return {
      output: {
        page: `${domain}.md`,
        wordCount,
        needsSplit,
        sourcesUsed: sourceContents.map((s) => s.name),
        action: existingPage ? 'updated' : 'created',
      },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }

  private inferDomain(description: string): string {
    const lower = description.toLowerCase();
    const domains = ['strategy', 'marketing', 'security', 'architecture', 'finance', 'engineering', 'design', 'legal'];
    return domains.find((d) => lower.includes(d)) ?? 'general';
  }
}
