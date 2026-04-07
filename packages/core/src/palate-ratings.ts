import { getDb } from './task-queue.js';
import { runFitnessUpdate } from './palate-sources.js';

// ── Palate Connoisseur Loop (Phase 4) ─────────────────────────────────────
// Rafael rates wiki pages. Ratings propagate to source fitness via Darwinian updates.

export interface WikiRating {
  id: number;
  page: string;
  rating: number;
  notes: string | null;
  ratedBy: string;
  createdAt: number;
}

/** Rate a wiki page (1-5). Triggers fitness update. */
export function rateWikiPage(page: string, rating: number, notes?: string): WikiRating {
  if (rating < 1 || rating > 5) throw new Error('Rating must be 1-5');

  const result = getDb().prepare(`
    INSERT INTO wiki_ratings (page, rating, notes, rated_by, created_at)
    VALUES (?, ?, ?, 'rafael', ?)
  `).run(page, rating, notes ?? null, Date.now());

  // Trigger fitness update after each rating
  runFitnessUpdate();

  return {
    id: Number(result.lastInsertRowid),
    page,
    rating,
    notes: notes ?? null,
    ratedBy: 'rafael',
    createdAt: Date.now(),
  };
}

/** Get all ratings for a wiki page. */
export function getPageRatings(page: string): WikiRating[] {
  const rows = getDb().prepare(`
    SELECT * FROM wiki_ratings WHERE page = ? ORDER BY created_at DESC
  `).all(page) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r.id as number,
    page: r.page as string,
    rating: r.rating as number,
    notes: r.notes as string | null,
    ratedBy: r.rated_by as string,
    createdAt: r.created_at as number,
  }));
}

/** Get average rating across all pages. */
export function getRatingSummary(): {
  totalRatings: number;
  averageRating: number;
  byPage: Record<string, { count: number; avg: number }>;
} {
  const rows = getDb().prepare(`
    SELECT page, COUNT(*) as cnt, AVG(rating) as avg_rating
    FROM wiki_ratings
    GROUP BY page
  `).all() as Array<{ page: string; cnt: number; avg_rating: number }>;

  const byPage: Record<string, { count: number; avg: number }> = {};
  let totalRatings = 0;
  let totalSum = 0;

  for (const r of rows) {
    byPage[r.page] = { count: r.cnt, avg: Math.round(r.avg_rating * 100) / 100 };
    totalRatings += r.cnt;
    totalSum += r.avg_rating * r.cnt;
  }

  return {
    totalRatings,
    averageRating: totalRatings > 0 ? Math.round((totalSum / totalRatings) * 100) / 100 : 0,
    byPage,
  };
}
