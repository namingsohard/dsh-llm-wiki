import type { Freshness, WikiPage } from '../types.js';
/**
 * Freshness buckets derived from a page's `updated` timestamp. Freshness
 * feeds retrieval scoring and the Knowledge Router's coverage verdict.
 *
 * @module dsh-llm-wiki/retrieval/freshness
 */
/** Bucket a page's age against the configured day thresholds. */
export declare function freshnessOf(page: Pick<WikiPage, 'updated'>, agingAfterDays: number, staleAfterDays: number, now?: Date): Freshness;
/** Multiplicative score weight for a freshness bucket. */
export declare function freshnessWeight(freshness: Freshness): number;
//# sourceMappingURL=freshness.d.ts.map