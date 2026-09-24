import type { Context } from '@deepseek-ai/cordis';
import { Config as ConfigSchema, resolveConfig, resolveWikiRoot, type WikiConfig } from './config.js';
import { createPromptSource } from './prompt.js';
import { Mutator } from './mutation/mutator.js';
import { WikiStore } from './storage/markdown-store.js';
import { StagingQueue } from './storage/staging.js';
import { registerWikiTools } from './tools/wiki-tools.js';
import { registerNudgeHook } from './hooks/wiki-nudge.js';
import { registerWikiHttp } from './browser/wiki-http.js';

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

export const name = 'wiki';

/** Services this plugin consumes from the harness. */
export const inject = ['tools', 'systemPrompt'];

/** Schemastery config schema surfaced to DSH settings. */
export const Config = ConfigSchema;

export type Config = WikiConfig;

export { resolveConfig, resolveWikiRoot } from './config.js';
export { WikiStore } from './storage/markdown-store.js';
export { Mutator } from './mutation/mutator.js';
export { lintWiki } from './validator/wiki-linter.js';
export { searchWiki } from './retrieval/grep-retriever.js';
export { routeQuery } from './router/knowledge-router.js';

/** Register the wiki tools, the prompt playbooks, and initialize storage. */
export function apply(ctx: Context, config?: Partial<WikiConfig>): void {
  const resolved = resolveConfig(config);
  const root = resolveWikiRoot(resolved);
  const store = new WikiStore(root, ctx.logger);
  const mutator = new Mutator(store, resolved);

  const prompt = createPromptSource(ctx.logger);
  const tools = registerWikiTools(ctx, store, mutator, resolved, prompt.stats);

  // The human-facing side: read-only routes feeding the sidebar wiki browser
  // (client/wiki-client.js). No-op on hosts without a web surface.
  registerWikiHttp(ctx, store, new StagingQueue(store.root), resolved);

  ctx.systemPrompt.section({
    name: 'tool:wiki',
    // Sit next to the web tools it routes between (web_search/web_fetch).
    order: ctx.systemPrompt.getSectionOrder('TOOL_WEB_SEARCH') + 25,
    // Byte-stable for the session: a section that changes mid-session makes
    // the harness rewrite the leading system message, which invalidates the
    // provider's cached prefix for the whole conversation. Volatile counts go
    // to the context below instead, where the harness appends them on change.
    text: () => prompt.provider(root),
    interpolate: false,
  });

  // Dynamic runtime context is the cache-safe channel for volatile state, but
  // it is newer than the section API. On a harness that predates it the state
  // line simply stays home — every tool result still reports exact counts.
  if (typeof ctx.systemPrompt.context === 'function' && typeof ctx.systemPrompt.getContextOrder === 'function') {
    ctx.systemPrompt.context({
      name: 'wiki:state',
      // After the harness's own runtime facts; the wiki is one of them.
      order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 10,
      // Coarse and latched, so this appends a couple of times per session at most.
      text: () => prompt.stateProvider(),
    });
  } else {
    ctx.logger?.warn?.('dsh-llm-wiki: this harness has no systemPrompt.context() — live wiki state will not be announced');
  }

  // The prompt says wiki-first; this is what notices when a turn ignored it.
  // The listeners observe without blocking and fold at most one reminder into
  // the next step's input, so the turn is never extended and the user-facing
  // answer stays the last message. They are scoped to the plugin's lifetime by
  // the harness dispatcher.
  registerNudgeHook(ctx, resolved.nudge, prompt.stats);

  // Best-effort: create the directory skeleton at startup so an empty wiki
  // is browsable immediately. Tool calls re-ensure it defensively.
  void store.ensureInit().then(
    async () => {
      await store.rebuildIndex();
      await tools.refresh();
    },
    (error: unknown) => ctx.logger?.warn?.('dsh-llm-wiki: wiki root initialization failed: %s', error instanceof Error ? error.message : String(error)),
  );

  ctx.logger?.info?.('dsh-llm-wiki: active — semantic memory at %s (write gate: %s, nudge: %s)', root, resolved.approval, resolved.nudge);
}
