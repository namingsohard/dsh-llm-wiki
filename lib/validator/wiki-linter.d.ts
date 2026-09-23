import type { LintIssue } from '../types.js';
import type { WikiConfig } from '../config.js';
import type { ParseFailure, WikiStore } from '../storage/markdown-store.js';
/**
 * Wiki Linter: long-term quality maintenance for the knowledge layer.
 * Deterministic checks — duplicate pages, broken links, stale knowledge,
 * orphan pages, references to deprecated/merged pages, and oversize pages.
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
//# sourceMappingURL=wiki-linter.d.ts.map