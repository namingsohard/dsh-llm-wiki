import type { MatchStats, PageKind, SearchHit, WikiPage } from '../types.js';
import type { WikiStore, ParseFailure } from '../storage/markdown-store.js';
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
}
export interface SearchResult {
    hits: SearchHit[];
    scanned: number;
    failures: ParseFailure[];
}
/** Run a ranked search over the wiki. */
export declare function searchWiki(store: WikiStore, options: SearchOptions): Promise<SearchResult>;
//# sourceMappingURL=grep-retriever.d.ts.map