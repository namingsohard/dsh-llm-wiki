import type { LintIssue, MutationOp, MutationResult, WikiPage } from '../types.js';
import type { WikiConfig } from '../config.js';
import type { WikiStore } from '../storage/markdown-store.js';
import { WikiGraph, type DanglingEdge, type GraphStats } from '../graph/graph.js';
import { type NeighborSuggestion } from '../graph/suggest.js';
/**
 * Mutation Engine: applies incremental knowledge mutations to the wiki —
 * CREATE / UPDATE / MERGE / LINK / DEPRECATE — instead of rewriting pages.
 * CREATE passes through the Admission Controller; every outcome (applied,
 * rejected, error) is journaled so the update history stays auditable.
 *
 * Graph maintenance rides on the same seam. A batch is where a page gains
 * edges, so it is also where a missing edge is still cheap to notice: after the
 * writes land, the engine re-reads the corpus, rebuilds the derived graph, and
 * reports what the batch did to the link structure — dangling edges, the same
 * scoped lint findings `wiki_lint` would produce, and nominated links for the
 * pages it touched. Nominating is all it does; an edge stays a decision.
 *
 * Concurrency: mutations route through the store's in-process lock; page
 * revisions make lost updates detectable by the linter, not silently merged.
 *
 * @module dsh-llm-wiki/mutation/mutator
 */
/** What the batch changed about the graph, and what it still leaves open. */
export interface GraphFeedback {
    /** Corpus shape (whole wiki, not just the batch). */
    stats: GraphStats;
    /** Edges the touched pages declare toward pages that do not exist. */
    dangling: DanglingEdge[];
    /** Candidate links per touched wiki-layer page. Nominations: nothing here is written. */
    suggestions: {
        id: string;
        candidates: NeighborSuggestion[];
    }[];
    /** `wiki_lint` checks over the touched pages only. */
    findings: LintIssue[];
    /** Advice worth stating in words (a page that gained no edge, a target to fix). */
    notes: string[];
    /** True when this feedback describes a proposal, not a applied write. */
    preview: boolean;
}
export interface MutateOutcome {
    results: MutationResult[];
    applied: number;
    rejected: number;
    indexRebuilt: boolean;
    /** Graph feedback for the batch, when graph reporting is enabled. */
    graph: GraphFeedback;
}
export declare class Mutator {
    private readonly store;
    private readonly config;
    constructor(store: WikiStore, config: WikiConfig);
    /** Apply a batch of operations. One bad operation fails only itself. */
    apply(ops: readonly MutationOp[]): Promise<MutateOutcome>;
    /**
     * What the graph would look like if this batch were applied, without writing
     * anything. The write gate parks most batches in `staging/`, so the same
     * feedback has to be legible at proposal time too — an edge that will dangle
     * is worth naming before the user ever sees the pitch.
     */
    previewGraph(ops: readonly MutationOp[]): Promise<GraphFeedback>;
    /** Rebuild the derived graph over the corpus (pass `pages` to reuse a listing). */
    graphOf(pages?: readonly WikiPage[]): Promise<WikiGraph>;
    /** Nominated links for one existing page, over a graph the caller already has. */
    suggestionsFor(page: WikiPage, graph: WikiGraph): NeighborSuggestion[];
    private suggestFor;
    /** Assemble the write-result graph feedback over a fresh graph. */
    private feedback;
    private log;
    private applyOne;
    private checkBodySize;
    /**
     * The one standard for a link target, applied to every write path. `off`
     * stays silent; `warn` writes and lets the feedback name the hole; `strict`
     * refuses, so a wiki can be held to "no edge points at nothing".
     */
    private checkTargets;
    private create;
    private update;
    private merge;
    private link;
    private deprecate;
}
/**
 * One-line human summary of graph feedback, for tool results and journals.
 * Deterministic and short: the numbers first, the advice only when there is a
 * hole worth naming.
 */
export declare function describeGraph(feedback: GraphFeedback): string;
//# sourceMappingURL=mutator.d.ts.map