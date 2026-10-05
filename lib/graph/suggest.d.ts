import type { PageKind } from '../types.js';
import type { WikiGraph } from './graph.js';
export interface SuggestOptions {
    limit: number;
    minScore: number;
    agingAfterDays: number;
    staleAfterDays: number;
}
/** One candidate relation, with the evidence behind it. */
export interface NeighborSuggestion {
    id: string;
    title: string;
    kind: PageKind;
    /** Relevance score on the `wiki_search` scale. */
    score: number;
    /** Terms the two pages share, strongest field first — why this is a candidate. */
    shared: string[];
}
/** The fields a suggestion needs; a page that does not exist yet qualifies. */
export interface SuggestionSubject {
    id: string;
    title: string;
    tags: readonly string[];
    body: string;
}
/**
 * Rank pages that could plausibly link to or from `subject`.
 *
 * Excluded by construction: the subject itself, source cards (provenance is a
 * different edge family), archived pages, and anything the subject already
 * touches in either direction — the point is the missing edge, not the existing one.
 */
export declare function suggestNeighbors(graph: WikiGraph, subject: SuggestionSubject, options: SuggestOptions): NeighborSuggestion[];
//# sourceMappingURL=suggest.d.ts.map