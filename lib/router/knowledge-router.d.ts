import type { Coverage, MatchStats, RouterDecision, SearchHit } from '../types.js';
/** True when a query asks for something time-sensitive (any language). */
export declare function isTimeSensitive(query: string): boolean;
/** Map raw top score (plus its coverage evidence) to a coverage bucket. */
export declare function coverageFromScore(topScore: number | undefined, match?: MatchStats): Coverage;
/**
 * Decide how to answer a query given retrieval results.
 * @param hits - ranked hits from {@link grep-retriever} (may be empty).
 * @param query - the original query (used for time-sensitivity detection).
 */
export declare function routeQuery(hits: readonly SearchHit[], query: string): RouterDecision;
//# sourceMappingURL=knowledge-router.d.ts.map