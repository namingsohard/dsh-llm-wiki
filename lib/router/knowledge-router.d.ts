import type { Coverage, RouterDecision, SearchHit } from '../types.js';
/** Map raw top score to a coverage bucket. */
export declare function coverageFromScore(topScore: number | undefined): Coverage;
/**
 * Decide how to answer a query given retrieval results.
 * @param hits - ranked hits from {@link grep-retriever} (may be empty).
 * @param query - the original query (used for time-sensitivity detection).
 */
export declare function routeQuery(hits: readonly SearchHit[], query: string): RouterDecision;
//# sourceMappingURL=knowledge-router.d.ts.map