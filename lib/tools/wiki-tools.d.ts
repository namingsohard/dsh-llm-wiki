import type { WikiConfig } from '../config.js';
import type { WikiStore } from '../storage/markdown-store.js';
import type { Mutator } from '../mutation/mutator.js';
import { type WikiPromptStats } from '../prompt.js';
/**
 * The seven model-facing tools: retrieval (`wiki_search`, `wiki_inspect`), the
 * Source Layer (`wiki_source_save`), the Mutation Engine (`wiki_mutate`), the
 * Linter (`wiki_lint`), and the two on-demand halves of the write gate and the
 * progressive-disclosure prompt (`wiki_guide`, `wiki_review`). All paths
 * resolve inside the configured wiki root; ids are validated so no call can
 * escape it.
 *
 * The write gate (`wiki.approval`, default `staging`) sits in front of every
 * write: proposals land in `staging/` and reach the live wiki only after the
 * user approves them through `wiki_review`. `inline` keeps the same gate but
 * asks at call time; `off` restores the v0.1 direct-write behaviour.
 *
 * Parameter notes for the dsh-tools schema DSL: optional properties OMIT
 * `required` (only `required: true` exists), and every object node states
 * `additionalProperties` explicitly.
 *
 * @module dsh-llm-wiki/tools
 */
/** One answer from the harness approval seam; `allowed-once` is the only grant. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
/** The part of `@deepseek-ai/dsh-user-approval` this plugin uses. */
export interface ApprovalSeam {
    request(req: {
        agent: unknown;
        toolName: string;
        callId?: string;
        reason?: string;
        signal?: AbortSignal;
    }): Promise<ApprovalOutcome>;
}
/** Registration context: the tool runtime, the optional approval lookup, and a logger. */
export interface ToolsHost {
    tools: {
        register(tool: {
            name: string;
        }): unknown;
    };
    /**
     * Cordis' optional service lookup. The plugin reads the approval seam with
     * `ctx.get('approval', false)` instead of declaring it in `inject`, so a
     * headless deployment without `dsh-user-approval` still loads the plugin —
     * gated writes then simply fail closed and stay pending.
     */
    get?(name: string, strict?: boolean): unknown;
    logger?: {
        warn?: (message: string, ...args: unknown[]) => void;
        info?: (message: string, ...args: unknown[]) => void;
    } | undefined;
}
/** What `registerWikiTools` hands back to the plugin entry. */
export interface WikiToolsHandle {
    /** The live snapshot the prompt section reads. */
    stats: WikiPromptStats;
    /** Recompute page/pending counts after startup initialization or out-of-band edits. */
    refresh(): Promise<void>;
}
export declare function registerWikiTools(ctx: ToolsHost, store: WikiStore, mutator: Mutator, config: WikiConfig, stats?: WikiPromptStats): WikiToolsHandle;
//# sourceMappingURL=wiki-tools.d.ts.map