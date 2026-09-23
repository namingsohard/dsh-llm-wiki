import type { PageKind, SearchHit, WikiPage } from '../types.js';
import type { WikiStore, ParseFailure } from '../storage/markdown-store.js';
/** Lowercase word tokens plus CJK unigram+bigram tokens. */
export declare function tokenize(text: string): string[];
/** Unique tokens preserving first-seen order — query side. */
export declare function queryTokens(query: string): string[];
/** Score one page against a query; 0 means "not a hit". */
export declare function scorePage(page: WikiPage, query: string, qTokens: string[], agingAfterDays: number, staleAfterDays: number): {
    score: number;
    freshness: SearchHit['freshness'];
    snippet: string;
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