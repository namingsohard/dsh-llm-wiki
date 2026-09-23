import type { Context } from '@deepseek-ai/cordis';
import { type WikiConfig } from './config.js';
/**
 * DSH-Wiki — Agent Semantic Memory plugin for the DeepSeek Harness.
 *
 * Gives the agent a long-term semantic memory layered over the filesystem
 * (`~/.dsh/wiki` by default): a Source Layer of raw material and a Wiki
 * Layer of concepts/entities/relations, reached through five tools
 * (`wiki_search`, `wiki_inspect`, `wiki_source_save`, `wiki_mutate`,
 * `wiki_lint`) and governed by prompt playbooks (Knowledge Router,
 * extraction, incremental mutation, validation).
 *
 * Settings live under the `wiki` key of DSH settings. Named exports follow
 * the Cordis plugin contract (`name` / `inject` / `Config` / `apply`).
 *
 * @module dsh-llm-wiki
 */
export declare const name = "wiki";
/** Services this plugin consumes from the harness. */
export declare const inject: string[];
/** Schemastery config schema surfaced to DSH settings. */
export declare const Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
    wikiRoot: import("@deepseek-ai/schemastery").default<string, string>;
    searchLimit: import("@deepseek-ai/schemastery").default<number, number>;
    includeSourcesInSearch: import("@deepseek-ai/schemastery").default<boolean, boolean>;
    agingAfterDays: import("@deepseek-ai/schemastery").default<number, number>;
    staleAfterDays: import("@deepseek-ai/schemastery").default<number, number>;
    admissionMinAverage: import("@deepseek-ai/schemastery").default<number, number>;
    admissionMinIndividual: import("@deepseek-ai/schemastery").default<number, number>;
    maxPageBytes: import("@deepseek-ai/schemastery").default<number, number>;
    maxSourceBytes: import("@deepseek-ai/schemastery").default<number, number>;
    maxInspectBytes: import("@deepseek-ai/schemastery").default<number, number>;
    lintOrphans: import("@deepseek-ai/schemastery").default<boolean, boolean>;
    mutationLog: import("@deepseek-ai/schemastery").default<boolean, boolean>;
}>, Schemastery.ObjectT<{
    wikiRoot: import("@deepseek-ai/schemastery").default<string, string>;
    searchLimit: import("@deepseek-ai/schemastery").default<number, number>;
    includeSourcesInSearch: import("@deepseek-ai/schemastery").default<boolean, boolean>;
    agingAfterDays: import("@deepseek-ai/schemastery").default<number, number>;
    staleAfterDays: import("@deepseek-ai/schemastery").default<number, number>;
    admissionMinAverage: import("@deepseek-ai/schemastery").default<number, number>;
    admissionMinIndividual: import("@deepseek-ai/schemastery").default<number, number>;
    maxPageBytes: import("@deepseek-ai/schemastery").default<number, number>;
    maxSourceBytes: import("@deepseek-ai/schemastery").default<number, number>;
    maxInspectBytes: import("@deepseek-ai/schemastery").default<number, number>;
    lintOrphans: import("@deepseek-ai/schemastery").default<boolean, boolean>;
    mutationLog: import("@deepseek-ai/schemastery").default<boolean, boolean>;
}>>;
export type Config = WikiConfig;
export { resolveConfig, resolveWikiRoot } from './config.js';
export { WikiStore } from './storage/markdown-store.js';
export { Mutator } from './mutation/mutator.js';
export { lintWiki } from './validator/wiki-linter.js';
export { searchWiki } from './retrieval/grep-retriever.js';
export { routeQuery } from './router/knowledge-router.js';
/** Register the wiki tools, the prompt playbooks, and initialize storage. */
export declare function apply(ctx: Context, config?: Partial<WikiConfig>): void;
//# sourceMappingURL=index.d.ts.map