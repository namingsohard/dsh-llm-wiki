import type { Freshness, WikiPage } from '../types.js';

/**
 * Freshness buckets derived from a page's `updated` timestamp. Freshness
 * feeds retrieval scoring and the Knowledge Router's coverage verdict.
 *
 * @module dsh-llm-wiki/retrieval/freshness
 */

/** Bucket a page's age against the configured day thresholds. */
export function freshnessOf(page: Pick<WikiPage, 'updated'>, agingAfterDays: number, staleAfterDays: number, now: Date = new Date()): Freshness {
  const updated = Date.parse(page.updated);
  if (Number.isNaN(updated)) return 'stale';
  const ageDays = (now.getTime() - updated) / 86_400_000;
  if (ageDays >= staleAfterDays) return 'stale';
  if (ageDays >= agingAfterDays) return 'aging';
  return 'fresh';
}

/** Multiplicative score weight for a freshness bucket. */
export function freshnessWeight(freshness: Freshness): number {
  switch (freshness) {
    case 'fresh':
      return 1;
    case 'aging':
      return 0.9;
    case 'stale':
      return 0.7;
  }
}
