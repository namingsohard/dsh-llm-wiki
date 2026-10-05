import type { MatchStats, PageKind, SearchHit, WikiPage } from '../types.js';
import type { WikiStore, ParseFailure } from '../storage/markdown-store.js';
import type { GraphOptions } from '../graph/graph.js';
/** Lowercase word tokens plus CJK unigram+bigram tokens. */
export declare function tokenize(text: string): string[];
/** Unique tokens preserving first-seen order — query side. */
export declare function queryTokens(query: string): string[];
/**
 * How much a single query token is worth. Matching is substring matching, and a
 * one-character token is a substring of a great many unrelated words: 地 is in
 * 地球, 地图, 地理 and 土地 alike, and `g` is in "using" and "config". A Han
 * bigram or a real Latin word is specific enough to count in full. Weights stay
 * in [0, 1], which keeps the score thresholds and the coverage ratio on one scale.
 */
export declare function tokenWeight(token: string): number;
/** Score one page against a query; 0 means "not a hit". */
export declare function scorePage(page: WikiPage, query: string, qTokens: string[], agingAfterDays: number, staleAfterDays: number): {
    score: number;
    freshness: SearchHit['freshness'];
    snippet: string;
    match: MatchStats;
} | undefined;
export interface SearchOptions {
    query: string;
    kinds?: PageKind[];
    limit: number;
    includeDeprecated: boolean;
    agingAfterDays: number;
    staleAfterDays: number;
    /**
     * One-hop graph expansion (see `docs/proposal-graph-maintenance.md`, R7).
     * Absent means off; the router's coverage verdict is computed from `hits`
     * only, so a neighbor can never make the wiki look more covered than it is.
     */
    expand?: {
        limit: number;
        graph: GraphOptions;
    };
}
/** A page reached through an edge instead of through the query. */
export interface RelatedHit {
    id: string;
    kind: PageKind;
    title: string;
    status: WikiPage['status'];
    /** Relevance to the query; 0 when the neighbor matches nothing of it. */
    score: number;
    snippet: string;
    /** Which hit(s) this page is one edge away from. */
    via: string[];
    /** Relation label of the first connecting edge, when labelled. */
    relation?: string;
}
export interface SearchResult {
    hits: SearchHit[];
    /** Graph neighbors of the hits, when expansion was asked for. Never counted as coverage. */
    related: RelatedHit[];
    scanned: number;
    failures: ParseFailure[];
}
/**
 * One-hop neighbors of the hits, ranked by what relevance they have to the
 * query. Deterministic, and reported separately from the hits precisely because
 * "connected to an answer" is not "an answer".
 */
export declare function expandNeighbors(pages: readonly WikiPage[], hits: readonly SearchHit[], options: {
    query: string;
    qTokens: string[];
    limit: number;
    graph: GraphOptions;
    agingAfterDays: number;
    staleAfterDays: number;
}): RelatedHit[];
/** Run a ranked search over the wiki. */
export declare function searchWiki(store: WikiStore, options: SearchOptions): Promise<SearchResult>;
//# sourceMappingURL=grep-retriever.d.ts.map