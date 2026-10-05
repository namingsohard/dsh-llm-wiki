import type { LintIssue } from '../types.js';
import type { WikiConfig } from '../config.js';
import type { ParseFailure, WikiStore } from '../storage/markdown-store.js';
import { WikiGraph } from '../graph/graph.js';
/**
 * Wiki Linter: long-term quality maintenance for the knowledge layer.
 * Deterministic checks — duplicate pages, broken links, stale knowledge,
 * orphan pages, references to deprecated/merged pages, uncited source cards,
 * and oversize pages. The checks themselves live in `validator/checks.ts`,
 * shared with the mutation engine so a defect is named at write time as well.
 *
 * Report-only by design: fixes are knowledge decisions and go back through
 * the mutation pipeline (`wiki_mutate`).
 *
 * @module dsh-llm-wiki/validator/wiki-linter
 */
export interface LintReport {
    issues: LintIssue[];
    counts: {
        warn: number;
        info: number;
    };
    scanned: number;
    parseFailures: ParseFailure[];
}
/** Run all lint checks over the wiki. */
export declare function lintWiki(store: WikiStore, config: WikiConfig): Promise<LintReport>;
/** The graph the linter saw, for callers that want its shape (browser, stats). */
export declare function lintGraph(store: WikiStore, config: WikiConfig): Promise<WikiGraph>;
//# sourceMappingURL=wiki-linter.d.ts.map