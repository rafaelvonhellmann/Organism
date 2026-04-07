import * as fs from 'fs';
import * as path from 'path';
import { writeAudit } from './audit.js';
import { getDb } from './task-queue.js';

// ── Palate Source Registry ────────────────────────────────────────────────
// Curated knowledge sources beyond the static knowledgeSources in capability-registry.json.

const SOURCES_PATH = path.resolve(process.cwd(), 'knowledge/palate/sources.json');
const SOURCES_DIR = path.resolve(process.cwd(), 'knowledge/palate/sources');
const MAX_SOURCE_BYTES = 50 * 1024; // 50KB max per source

export interface PalateSource {
  id: string;
  localPath: string;
  url?: string;
  addedBy: string;
  addedAt: number;
  fitness: number;
  tags: string[];
  scope: string;          // 'all' or a project ID
  approved: boolean;
}

interface SourcesFile {
  version: number;
  sources: PalateSource[];
}

function loadSourcesFile(): SourcesFile {
  if (!fs.existsSync(SOURCES_PATH)) {
    return { version: 1, sources: [] };
  }
  return JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8')) as SourcesFile;
}

function saveSourcesFile(data: SourcesFile): void {
  fs.writeFileSync(SOURCES_PATH, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Add a new source to the registry. External URLs are fetched, sanitized, and saved locally.
 * All new sources are unapproved by default — must be explicitly approved before injection.
 */
export async function addSource(opts: {
  url?: string;
  localPath?: string;
  tags: string[];
  scope: string;
  addedBy?: string;
}): Promise<PalateSource> {
  const data = loadSourcesFile();

  // Generate ID from filename or URL
  let id: string;
  let localPath: string;

  if (opts.url) {
    // Fetch and sanitize external URL
    const resp = await fetch(opts.url);
    if (!resp.ok) throw new Error(`Failed to fetch ${opts.url}: ${resp.status}`);
    let text = await resp.text();

    // Sanitize: strip scripts, forms, iframes
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<form[\s\S]*?<\/form>/gi, '');
    text = text.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    // Strip remaining HTML tags (rough conversion to plaintext/markdown)
    text = text.replace(/<[^>]+>/g, '');
    // Collapse whitespace
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    // Truncate to max size
    if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) {
      const truncated = Buffer.from(text, 'utf8').subarray(0, MAX_SOURCE_BYTES).toString('utf8');
      text = truncated + '\n\n[TRUNCATED: original exceeded 50KB limit]';
      console.warn(`[palate] Source from ${opts.url} truncated to 50KB`);
    }

    id = new URL(opts.url).pathname.split('/').filter(Boolean).pop()?.replace(/\.[^.]+$/, '') ?? `url-${Date.now()}`;
    // Ensure unique
    if (data.sources.find((s) => s.id === id)) id = `${id}-${Date.now()}`;

    if (!fs.existsSync(SOURCES_DIR)) fs.mkdirSync(SOURCES_DIR, { recursive: true });
    localPath = `knowledge/palate/sources/${id}.md`;
    fs.writeFileSync(path.resolve(process.cwd(), localPath), text, 'utf8');
  } else if (opts.localPath) {
    const abs = path.resolve(process.cwd(), opts.localPath);
    if (!fs.existsSync(abs)) throw new Error(`Local file not found: ${abs}`);
    localPath = opts.localPath;
    id = path.basename(localPath, path.extname(localPath));
    if (data.sources.find((s) => s.id === id)) id = `${id}-${Date.now()}`;
  } else {
    throw new Error('Must provide either url or localPath');
  }

  const source: PalateSource = {
    id,
    localPath,
    url: opts.url,
    addedBy: opts.addedBy ?? 'cli',
    addedAt: Date.now(),
    fitness: 0.5,
    tags: opts.tags,
    scope: opts.scope,
    approved: false, // Always unapproved by default
  };

  data.sources.push(source);
  saveSourcesFile(data);

  return source;
}

/** Mark a source as approved for injection. */
export function approveSource(id: string): PalateSource {
  const data = loadSourcesFile();
  const source = data.sources.find((s) => s.id === id);
  if (!source) throw new Error(`Source '${id}' not found`);
  source.approved = true;
  saveSourcesFile(data);
  return source;
}

/** List all sources, optionally filtered by scope. */
export function listSources(scope?: string): PalateSource[] {
  const data = loadSourcesFile();
  if (!scope) return data.sources;
  return data.sources.filter((s) => s.scope === 'all' || s.scope === scope);
}

/** Get approved sources matching given tags. Used by palate.ts for extended resolution. */
export function getApprovedSourcesByTags(tags: string[], scope?: string): PalateSource[] {
  const data = loadSourcesFile();
  return data.sources.filter((s) => {
    if (!s.approved) return false;
    if (scope && s.scope !== 'all' && s.scope !== scope) return false;
    return s.tags.some((t) => tags.includes(t));
  });
}

/** Remove a source from the registry. Does not delete the file. */
export function removeSource(id: string): void {
  const data = loadSourcesFile();
  const idx = data.sources.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`Source '${id}' not found`);
  data.sources.splice(idx, 1);
  saveSourcesFile(data);
}

/** Update fitness score for a source. */
export function updateSourceFitness(id: string, delta: number): void {
  const data = loadSourcesFile();
  const source = data.sources.find((s) => s.id === id);
  if (!source) return;
  source.fitness = Math.max(0, Math.min(1, source.fitness + delta));
  saveSourcesFile(data);
}

// ── Darwinian Fitness (Phase 3) ───────────────────────────────────────────

/**
 * Record that a source was injected into a task. Updates source_fitness table.
 */
export function recordSourceInjection(sourceId: string, projectId: string = 'all'): void {
  getDb().prepare(`
    INSERT INTO source_fitness (source_id, project_id, injections, last_injected)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(source_id, project_id) DO UPDATE SET
      injections = injections + 1,
      last_injected = excluded.last_injected
  `).run(sourceId, projectId, Date.now());
}

/**
 * Update source fitness based on wiki ratings.
 * Sources cited in high-rated wiki pages get fitness boosts.
 * Sources cited in low-rated pages get penalized.
 * Sources unused for 30 days decay.
 */
export function runFitnessUpdate(): { updated: number; dormant: string[] } {
  const data = loadSourcesFile();
  const dormant: string[] = [];
  let updated = 0;

  // Get recent wiki ratings
  const ratings = getDb().prepare(`
    SELECT page, rating FROM wiki_ratings
    WHERE created_at > ? ORDER BY created_at DESC
  `).all(Date.now() - 30 * 24 * 60 * 60 * 1000) as Array<{ page: string; rating: number }>;

  // Build page→rating map (average if multiple ratings)
  const pageRatings = new Map<string, number[]>();
  for (const r of ratings) {
    if (!pageRatings.has(r.page)) pageRatings.set(r.page, []);
    pageRatings.get(r.page)!.push(r.rating);
  }

  // Get source injection history for attribution
  const injections = getDb().prepare(`
    SELECT payload FROM audit_log
    WHERE action = 'source_injection' AND ts > ?
  `).all(Date.now() - 30 * 24 * 60 * 60 * 1000) as Array<{ payload: string }>;

  // Build source→injection count
  const sourceActivity = new Map<string, number>();
  for (const row of injections) {
    const p = JSON.parse(row.payload);
    const paths = (p.loadedPaths ?? p.sourcePaths ?? []) as string[];
    for (const sp of paths) {
      sourceActivity.set(sp, (sourceActivity.get(sp) ?? 0) + 1);
    }
  }

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (const source of data.sources) {
    let delta = 0;

    // Check if this source contributed to any rated wiki pages
    // (Simple heuristic: source tags match page name)
    for (const [page, ratingList] of pageRatings) {
      const avg = ratingList.reduce((a, b) => a + b, 0) / ratingList.length;
      const pageMatchesSource = source.tags.some((t) => page.toLowerCase().includes(t));
      if (pageMatchesSource) {
        if (avg >= 4) delta += 0.05;       // Good rating boost
        else if (avg <= 2) delta -= 0.1;    // Bad rating penalty
      }
    }

    // Decay for unused sources
    const activity = sourceActivity.get(source.localPath) ?? 0;
    if (activity === 0) {
      const fitnessRow = getDb().prepare(`
        SELECT last_injected FROM source_fitness WHERE source_id = ?
      `).get(source.id) as { last_injected: number } | undefined;

      if (!fitnessRow || (fitnessRow.last_injected && fitnessRow.last_injected < thirtyDaysAgo)) {
        delta -= 0.02; // Weekly decay for 30+ day unused
      }
    }

    if (delta !== 0) {
      source.fitness = Math.max(0, Math.min(1, source.fitness + delta));
      updated++;
    }

    // Mark dormant if below threshold
    if (source.fitness < 0.2) {
      dormant.push(source.id);
    }
  }

  if (updated > 0) saveSourcesFile(data);

  return { updated, dormant };
}

/** Get injection stats from audit log. */
export function getInjectionStats(): {
  totalInjections: number;
  totalRawTokens: number;
  totalDistilledTokens: number;
  totalSavings: number;
  byCapability: Record<string, number>;
} {
  const rows = getDb().prepare(`
    SELECT payload FROM audit_log WHERE action = 'source_injection' ORDER BY ts DESC LIMIT 500
  `).all() as Array<{ payload: string }>;

  let totalInjections = 0;
  let totalRawTokens = 0;
  let totalDistilledTokens = 0;
  let totalSavings = 0;
  const byCapability: Record<string, number> = {};

  for (const row of rows) {
    const p = JSON.parse(row.payload);
    totalInjections++;
    totalRawTokens += p.rawTokens ?? p.estimatedTokens ?? 0;
    totalDistilledTokens += p.distilledTokens ?? p.estimatedTokens ?? 0;
    totalSavings += p.tokenSavings ?? 0;
    const cap = p.capabilityId ?? 'unknown';
    byCapability[cap] = (byCapability[cap] ?? 0) + 1;
  }

  return { totalInjections, totalRawTokens, totalDistilledTokens, totalSavings, byCapability };
}
