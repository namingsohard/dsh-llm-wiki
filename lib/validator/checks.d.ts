import type { GraphOptions, WikiGraph } from '../graph/graph.js';
import type { LintIssue, WikiPage } from '../types.js';
import type { WikiConfig } from '../config.js';
/**
 * The deterministic checks, expressed once.
 *
 * `wiki_lint` runs them over the whole corpus; the mutation engine runs the
 * same set over just the pages it touched and folds the findings into the write
 * result. One implementation means a defect cannot be invisible at write time
 * and loud at lint time — the asymmetry that let a dangling edge into the wiki
 * and sit there unnoticed (docs/proposal-graph-maintenance.md, G3).
 *
 * Every check is scoped: a subject set plus the graph it lives in. Nothing here
 * walks the corpus twice or allocates per pair beyond the duplicate scan.
 *
 * @module dsh-llm-wiki/validator/checks
 */
/** How the duplicate check treats a pair. */
export type PairScope = 
/** Corpus mode: report a pair once, attributed to the earlier page. */
'corpus'
/** Scoped mode: report the pair on the subject, even if the other page came first. */
 | 'subject';
export interface CheckContext {
    graph: WikiGraph;
    config: WikiConfig;
    /** Corpus order, so `corpus` mode reports each pair exactly once. */
    order: ReadonlyMap<string, number>;
    pairScope?: PairScope;
}
/** Run every check over `subjects` against the whole graph. */
export declare function runChecks(ctx: CheckContext, subjects: readonly WikiPage[]): LintIssue[];
/** Corpus-level convenience: build the order map the checks need. */
export declare function corpusOrder(pages: readonly WikiPage[]): Map<string, number>;
/** The graph options implied by a resolved configuration. */
export declare function graphOptionsOf(config: WikiConfig): GraphOptions;
/**
 * Scoped variant of the corpus lint: the same checks over one page set. Used by
 * the write path, where a page pair must be reported on the page the agent just
 * touched even if the other page is older — hence `pairScope: 'subject'`.
 */
export declare function checksFor(graph: WikiGraph, config: WikiConfig, subjects: readonly WikiPage[]): LintIssue[];
//# sourceMappingURL=checks.d.ts.map