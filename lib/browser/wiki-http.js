import { isValidPageId } from '../storage/id-slug.js';
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
export const WIKI_TREE_ROUTE = '/wiki/tree';
export const WIKI_PAGE_ROUTE = '/wiki/page';
export const WIKI_STAGED_ROUTE = '/wiki/staged';
/** The page kinds a request may name, in the order the tree lists them. */
const KINDS = ['concept', 'entity', 'source'];
/** JSON response (no-store: the wiki changes under the agent's hands). */
function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
}
/** Trim a pitch to one list line without cutting mid-multibyte-run visually. */
function oneLine(text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}
/** Sort rows by title, then id; CJK titles sort by locale default. */
function byTitle(a, b) {
    return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}
/**
 * Build the read-only handlers over one store. A missing root answers an
 * empty tree rather than an error — an agent that never wrote is a valid
 * state, and the first `ensureInit` race (startup mkdir) must not 500.
 */
export function createWikiHttpHandlers(store, staging, config) {
    const methodGuard = (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD')
            return true;
        res.statusCode = 405;
        res.setHeader('allow', 'GET');
        res.end();
        return false;
    };
    const queryOf = (req) => {
        try {
            return new URL(String(req.url ?? ''), 'http://wiki.local');
        }
        catch {
            return undefined;
        }
    };
    const tree = async (req, res) => {
        if (!methodGuard(req, res))
            return;
        const [{ pages, failures }, staged] = await Promise.all([store.listPages(KINDS), staging.list()]);
        const sections = KINDS.map((kind) => ({
            kind,
            pages: pages
                .filter((page) => page.kind === kind)
                .map((page) => ({ id: page.id, title: page.title, status: page.status, updated: page.updated, tags: page.tags }))
                .sort(byTitle),
        }));
        const stagingRows = staged.entries.map((entry) => ({
            id: entry.id,
            type: entry.type,
            kind: entry.kind,
            staged_at: entry.staged_at,
            pitch: oneLine(entry.pitch),
        }));
        sendJson(res, 200, {
            ok: true,
            root: store.root,
            version: store.version,
            approval: config.approval,
            sections,
            staging: stagingRows,
            // Pages on disk that failed to parse: shown verbatim so the browser
            // stops looking like it "lost" files the linter can still see.
            failures: failures.map((failure) => ({ path: failure.path, message: failure.message })),
        });
    };
    const page = async (req, res) => {
        if (!methodGuard(req, res))
            return;
        const query = queryOf(req);
        const kind = query?.searchParams.get('kind') ?? '';
        const id = query?.searchParams.get('id') ?? '';
        if (!query || !KINDS.includes(kind) || !isValidPageId(id)) {
            sendJson(res, 400, { ok: false, error: 'wiki-http/invalid-request' });
            return;
        }
        const loaded = await store.read(id);
        // `read` searches every kind; the requested directory must actually hold it.
        if (loaded === undefined || loaded.kind !== kind) {
            sendJson(res, 404, { ok: false, error: 'wiki-http/not-found' });
            return;
        }
        sendJson(res, 200, { ok: true, ...pagePayload(loaded, config) });
    };
    const staged = async (req, res) => {
        if (!methodGuard(req, res))
            return;
        const query = queryOf(req);
        const id = query?.searchParams.get('id') ?? '';
        if (!query || !isValidPageId(id)) {
            sendJson(res, 400, { ok: false, error: 'wiki-http/invalid-request' });
            return;
        }
        const entry = await staging.read(id);
        if (entry === undefined) {
            sendJson(res, 404, { ok: false, error: 'wiki-http/not-found' });
            return;
        }
        sendJson(res, 200, { ok: true, staged: stagedPayload(entry) });
    };
    return { tree, page, staged };
}
/** Strip a page to wire fields, truncating a body past the inspect cap. */
function pagePayload(page, config) {
    const cap = config.maxInspectBytes;
    const body = Buffer.byteLength(page.body, 'utf8') > cap ? `${page.body.slice(0, cap)}\n\n…` : page.body;
    return {
        page: {
            id: page.id,
            kind: page.kind,
            title: page.title,
            status: page.status,
            revision: page.revision,
            created: page.created,
            updated: page.updated,
            tags: page.tags,
            links: page.links,
            sources: page.sources,
            ...(page.url === undefined ? {} : { url: page.url }),
            ...(page.obtained === undefined ? {} : { obtained: page.obtained }),
            ...(page.supersededBy === undefined ? {} : { supersededBy: page.supersededBy }),
            body,
            truncated: body !== page.body,
        },
    };
}
/** Cap a staged payload the same way; the JSON viewer never needs more. */
function stagedPayload(entry) {
    return { ...entry };
}
/** Mount-order patience: which service arrives before this plugin is a per-boot race. */
const REGISTER_RETRY_MS = 500;
const REGISTER_WAIT_MS = 45_000;
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
export function registerWikiHttp(ctx, store, staging, config) {
    const handlers = createWikiHttpHandlers(store, staging, config);
    // A partial context (test harnesses call apply() against stubs without the
    // lifecycle surface) gets one attempt and no timer — nothing could own it.
    const managed = typeof ctx.effect === 'function';
    const body = () => {
        let lapseTimer;
        let stopped = false;
        let disposers;
        const fence = () => ctx.get('connection', false);
        const guard = (req, res) => {
            const connection = fence();
            if (connection === undefined) {
                // Fail closed: a web surface without the trust fence answers nothing.
                res.statusCode = 503;
                res.end();
                return true;
            }
            const rejection = connection.requestRejection(req);
            if (rejection === undefined)
                return false;
            res.statusCode = rejection;
            res.end();
            return true;
        };
        const tryRegister = () => {
            const webServer = ctx.get('webServer', false);
            if (webServer === undefined)
                return undefined;
            const registered = [];
            const route = (path, handler) => {
                registered.push(webServer.register({
                    kind: 'exact',
                    path,
                    handler: async (req, res) => {
                        if (guard(req, res))
                            return;
                        await handler(req, res).catch((error) => {
                            // A settled header means the only honest answer is to drop the socket body.
                            if (res.statusCode >= 200 && res.writableEnded !== true)
                                sendJson(res, 500, { ok: false, error: 'wiki-http/internal' });
                            ctx.logger?.warn?.('dsh-llm-wiki: wiki browser route %s failed: %s', path, error instanceof Error ? error.message : String(error));
                        });
                    },
                }));
            };
            route(WIKI_TREE_ROUTE, handlers.tree);
            route(WIKI_PAGE_ROUTE, handlers.page);
            route(WIKI_STAGED_ROUTE, handlers.staged);
            ctx.logger?.info?.('dsh-llm-wiki: wiki browser routes active at %s (root %s, fence %s)', WIKI_TREE_ROUTE, store.root, fence() === undefined ? 'pending' : 'ready');
            return registered;
        };
        disposers = tryRegister();
        if (disposers === undefined && managed) {
            const deadline = Date.now() + REGISTER_WAIT_MS;
            const tick = () => {
                if (stopped)
                    return;
                disposers = tryRegister();
                if (disposers !== undefined)
                    return;
                if (Date.now() < deadline)
                    lapseTimer = setTimeout(tick, REGISTER_RETRY_MS);
                else
                    ctx.logger?.debug?.('dsh-llm-wiki: no web surface within %dms — wiki browser routes stay off', REGISTER_WAIT_MS);
            };
            lapseTimer = setTimeout(tick, REGISTER_RETRY_MS);
        }
        return () => {
            stopped = true;
            if (lapseTimer !== undefined)
                clearTimeout(lapseTimer);
            for (const dispose of disposers ?? [])
                dispose();
        };
    };
    if (managed)
        ctx.effect(body, 'dsh-llm-wiki: wiki browser routes');
    else
        body();
}
//# sourceMappingURL=wiki-http.js.map