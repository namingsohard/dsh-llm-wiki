import type { MutationOp, MutationResult } from '../types.js';
import type { WikiConfig } from '../config.js';
import type { WikiStore } from '../storage/markdown-store.js';
/**
 * Mutation Engine: applies incremental knowledge mutations to the wiki —
 * CREATE / UPDATE / MERGE / LINK / DEPRECATE — instead of rewriting pages.
 * CREATE passes through the Admission Controller; every outcome (applied,
 * rejected, error) is journaled so the update history stays auditable.
 *
 * Concurrency: mutations route through the store's in-process lock; page
 * revisions make lost updates detectable by the linter, not silently merged.
 *
 * @module dsh-llm-wiki/mutation/mutator
 */
export interface MutateOutcome {
    results: MutationResult[];
    applied: number;
    rejected: number;
    indexRebuilt: boolean;
}
export declare class Mutator {
    private readonly store;
    private readonly config;
    constructor(store: WikiStore, config: WikiConfig);
    /** Apply a batch of operations. One bad operation fails only itself. */
    apply(ops: readonly MutationOp[]): Promise<MutateOutcome>;
    private log;
    private applyOne;
    private checkBodySize;
    private create;
    private update;
    private merge;
    private link;
    private deprecate;
}
//# sourceMappingURL=mutator.d.ts.map