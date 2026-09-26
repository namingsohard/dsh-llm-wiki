import type { Context } from '@deepseek-ai/cordis';
import { type WikiConfig } from './config.js';
/**
 * DSH-Wiki — Agent Semantic Memory plugin for the DeepSeek Harness.
 *
 * Gives the agent a long-term semantic memory layered over the filesystem
 * (`~/.dsh/wiki` by default): a Source Layer of provenance cards (a link and
 * a retrieval time — the wiki never stores the original text) and a Wiki
 * Layer of concepts/entities/relations, reached through seven tools
 * (`wiki_search`, `wiki_inspect`, `wiki_source_save`, `wiki_mutate`,
 * `wiki_review`, `wiki_lint`, `wiki_guide`) and governed by prompt playbooks
 * (Knowledge Router, extraction, incremental mutation, validation) pulled on
 * demand rather than inlined into the system prompt.
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
export declare const Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
    wikiRoot: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    searchLimit: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    includeSourcesInSearch: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    agingAfterDays: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    staleAfterDays: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    admissionMinAverage: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    admissionMinIndividual: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    maxPageBytes: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    maxInspectBytes: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    lintOrphans: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    mutationLog: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    approval: import("@deepseek-ai/schemastery").default<"staging" | "inline" | "off", "staging" | "inline" | "off", "defined">;
    maxStagedBytes: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    nudge: import("@deepseek-ai/schemastery").default<"off" | "next-step" | "turn-end", "off" | "next-step" | "turn-end", "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    wikiRoot: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    searchLimit: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    includeSourcesInSearch: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    agingAfterDays: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    staleAfterDays: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    admissionMinAverage: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    admissionMinIndividual: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    maxPageBytes: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    maxInspectBytes: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    lintOrphans: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    mutationLog: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    approval: import("@deepseek-ai/schemastery").default<"staging" | "inline" | "off", "staging" | "inline" | "off", "defined">;
    maxStagedBytes: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    nudge: import("@deepseek-ai/schemastery").default<"off" | "next-step" | "turn-end", "off" | "next-step" | "turn-end", "defined">;
}>>, "plain">;
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