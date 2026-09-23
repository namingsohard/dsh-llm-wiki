import { Config as ConfigSchema, resolveConfig, resolveWikiRoot } from './config.js';
import { createPromptSource } from './prompt.js';
import { Mutator } from './mutation/mutator.js';
import { WikiStore } from './storage/markdown-store.js';
import { registerWikiTools } from './tools/wiki-tools.js';
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
export const name = 'wiki';
/** Services this plugin consumes from the harness. */
export const inject = ['tools', 'systemPrompt'];
/** Schemastery config schema surfaced to DSH settings. */
export const Config = ConfigSchema;
export { resolveConfig, resolveWikiRoot } from './config.js';
export { WikiStore } from './storage/markdown-store.js';
export { Mutator } from './mutation/mutator.js';
export { lintWiki } from './validator/wiki-linter.js';
export { searchWiki } from './retrieval/grep-retriever.js';
export { routeQuery } from './router/knowledge-router.js';
/** Register the wiki tools, the prompt playbooks, and initialize storage. */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const root = resolveWikiRoot(resolved);
    const store = new WikiStore(root, ctx.logger);
    const mutator = new Mutator(store, resolved);
    registerWikiTools(ctx, store, mutator, resolved);
    const prompt = createPromptSource(ctx.logger);
    ctx.systemPrompt.section({
        name: 'tool:wiki',
        // Sit next to the web tools it routes between (web_search/web_fetch).
        order: ctx.systemPrompt.getSectionOrder('TOOL_WEB_SEARCH') + 25,
        text: () => prompt.provider(root),
        interpolate: false,
    });
    // Best-effort: create the directory skeleton at startup so an empty wiki
    // is browsable immediately. Tool calls re-ensure it defensively.
    void store.ensureInit().then(() => store.rebuildIndex(), (error) => ctx.logger?.warn?.('dsh-llm-wiki: wiki root initialization failed: %s', error instanceof Error ? error.message : String(error)));
    ctx.logger?.info?.('dsh-llm-wiki: active — semantic memory at %s', root);
}
//# sourceMappingURL=index.js.map