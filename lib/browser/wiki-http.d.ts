import type { Context } from '@deepseek-ai/cordis';
import type { WikiConfig } from '../config.js';
import type { StagingQueue } from '../storage/staging.js';
import type { WikiStore } from '../storage/markdown-store.js';
/**
 * Read-only HTTP surface for the wiki browser client plugin
 * (`client/wiki-client.js`). Two GET routes on the composition's `webServer`,
 * shaped after `@deepseek-ai/dsh-host-open-in-app`:
 *
 *   GET /wiki/tree           the whole wiki as one small JSON document
 *   GET /wiki/page?kind=&id= one page: parsed frontmatter + Markdown body
 *   GET /wiki/staged?id=     one staged proposal (write-gate queue item)
 *
 * The wiki root lives outside every session workspace, so the built-in
 * `workspaceFiles` Remote cannot list it; this module is the listing channel.
 * It never writes: promotion stays with `wiki_review` in the agent flow.
 *
 * Security mirrors open-in-app: every handler asks the composition's
 * `connection` service for a rejection first (Host/Origin fence + browser
 * login token), and ids are re-validated against the page-slug grammar before
 * anything touches the filesystem, so no request path can escape the root.
 *
 * Both `webServer` and `connection` are optional: this plugin also runs in
 * headless/test hosts, where the routes simply do not exist (one warning).
 *
 * @module dsh-llm-wiki/browser/wiki-http
 */
/** Route paths, also what the client bundle fetches (same-origin). */
export declare const WIKI_TREE_ROUTE = "/wiki/tree";
export declare const WIKI_PAGE_ROUTE = "/wiki/page";
export declare const WIKI_STAGED_ROUTE = "/wiki/staged";
/** The minimal response surface the handlers touch (node's ServerResponse fits). */
export interface WikiHttpResponse {
    statusCode: number;
    /** Node exposes it; the fake in tests may leave it undefined. */
    writableEnded?: boolean;
    setHeader(name: string, value: string): void;
    end(chunk?: string): void;
}
/** The minimal request surface the handlers touch (node's IncomingMessage fits). */
export interface WikiHttpRequest {
    method?: string;
    url?: string;
}
/** Handlers for the three routes, extracted so tests can drive them directly. */
export interface WikiHttpHandlers {
    tree(req: WikiHttpRequest, res: WikiHttpResponse): Promise<void>;
    page(req: WikiHttpRequest, res: WikiHttpResponse): Promise<void>;
    staged(req: WikiHttpRequest, res: WikiHttpResponse): Promise<void>;
}
/**
 * Build the read-only handlers over one store. A missing root answers an
 * empty tree rather than an error — an agent that never wrote is a valid
 * state, and the first `ensureInit` race (startup mkdir) must not 500.
 */
export declare function createWikiHttpHandlers(store: WikiStore, staging: StagingQueue, config: WikiConfig): WikiHttpHandlers;
/**
 * Register the three routes once this host carries a web surface. Optional on
 * purpose: `inject` stays host-agnostic (`tools`, `systemPrompt`), and a
 * headless host simply never shows a `webServer` — the wait lapses in silence.
 *
 * Neither service is captured once at apply time, because mount order is a
 * per-boot race (one boot served live 404s after `connection` turned out to
 * mount after this fiber). `webServer` is therefore awaited through bounded
 * retries, and the `connection` fence is resolved per request: absent means
 * fail closed with 503, and the moment the composition provides it every
 * route answers again — no host restart, the pane's reload is enough.
 */
export declare function registerWikiHttp(ctx: Context, store: WikiStore, staging: StagingQueue, config: WikiConfig): void;
//# sourceMappingURL=wiki-http.d.ts.map