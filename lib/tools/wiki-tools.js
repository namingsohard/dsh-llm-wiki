import { defineTool } from '@deepseek-ai/dsh-tools';
import { assertPageId, contentHash, sourceId } from '../storage/id-slug.js';
import { searchWiki } from '../retrieval/grep-retriever.js';
import { routeQuery } from '../router/knowledge-router.js';
import { lintWiki } from '../validator/wiki-linter.js';
function text(value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}
const MUTATION_NOTE = 'Incremental wiki mutation. Batch ALL of a task\'s knowledge changes in one call. Ops: ' +
    'create (needs admission {reusability,stability,novelty,abstraction} 0..3 — the Admission Controller rejects weak candidates); ' +
    'update (body replaces; tags/links/sources merge); ' +
    'merge (id -> into_id; the weaker id becomes a redirect stub); ' +
    'link (id -> to_id, optional relation); ' +
    'deprecate (keep for history, optionally superseded_by). ' +
    'Prefer update over create, link over prose duplication, deprecate over deletion. ' +
    'Link entries are "target" or "target | relation"; sources reference wiki_source_save ids. ' +
    'Each op reports applied/noop/rejected/error independently.';
export function registerWikiTools(ctx, store, mutator, config) {
    ctx.tools.register(defineTool({
        name: 'wiki_search',
        description: 'Search the persistent agent wiki (semantic memory) BEFORE reaching for the web. Returns ranked hits plus a Knowledge Router verdict: coverage (none/low/partial/high), use_wiki, need_web, and one-line advice. Wiki-first: reuse what is covered, fetch only what is missing. Deprecated pages are excluded unless include_deprecated.',
        parameters: {
            query: { type: 'string', required: true, description: 'Natural-language query; CJK and ASCII both tokenize.' },
            kind: { type: 'string', enum: ['concept', 'entity', 'source'], description: 'Restrict to one page class. Default: concept + entity (sources optional).' },
            limit: { type: 'integer', description: `Max hits (1..50). Default ${config.searchLimit}.` },
            include_deprecated: { type: 'boolean', description: 'Include deprecated pages (scored at half weight). Default false.' },
            include_sources: { type: 'boolean', description: 'Search the Source Layer (raw material) as well. Default from plugin config.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    hits: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', required: true },
                                kind: { type: 'string', required: true },
                                title: { type: 'string', required: true },
                                status: { type: 'string', required: true },
                                score: { type: 'number', required: true },
                                freshness: { type: 'string', required: true },
                                snippet: { type: 'string', required: true },
                                updated: { type: 'string', required: true },
                            },
                        },
                    },
                    coverage: { type: 'string', required: true, description: 'none | low | partial | high.' },
                    use_wiki: { type: 'boolean', required: true },
                    need_web: { type: 'boolean', required: true },
                    advice: { type: 'string', required: true },
                    total_pages: { type: 'integer', required: true },
                },
            },
            render: (_args, value) => text(value),
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            await store.ensureInit();
            exec.signal?.throwIfAborted();
            const kinds = args.kind !== undefined
                ? [args.kind]
                : ['concept', 'entity', ...((args.include_sources ?? config.includeSourcesInSearch) ? ['source'] : [])];
            const result = await searchWiki(store, {
                query: args.query,
                kinds,
                limit: args.limit ?? config.searchLimit,
                includeDeprecated: args.include_deprecated ?? false,
                agingAfterDays: config.agingAfterDays,
                staleAfterDays: config.staleAfterDays,
            });
            const decision = routeQuery(result.hits, args.query);
            return {
                hits: result.hits.map((hit) => ({
                    id: hit.id,
                    kind: hit.kind,
                    title: hit.title,
                    status: hit.status,
                    score: hit.score,
                    freshness: hit.freshness,
                    snippet: hit.snippet,
                    updated: hit.updated,
                })),
                coverage: decision.coverage,
                use_wiki: decision.useWiki,
                need_web: decision.needWeb,
                advice: decision.advice,
                total_pages: result.scanned,
            };
        },
        presentCall: (args) => ({ card: 'generic', title: `Wiki search: ${args.query}`, kind: 'search' }),
    }));
    ctx.tools.register(defineTool({
        name: 'wiki_inspect',
        description: 'Read one wiki page in full: frontmatter (status, revision, timestamps, tags, links, source ids), body, inbound links, and resolved source metadata. Use after wiki_search hits to reuse knowledge and trace it to its sources.',
        parameters: {
            id: { type: 'string', required: true, description: 'Page id from wiki_search or index.md.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    found: { type: 'boolean', required: true },
                    id: { type: 'string', required: true },
                    page: { type: 'json', required: true, description: 'Full page object, or null when not found.' },
                    inbound: { type: 'array', required: true, items: { type: 'string' } },
                    sources: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', required: true },
                                title: { type: 'string', required: true },
                                url: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                            },
                        },
                    },
                    truncated: { type: 'boolean', required: true },
                    note: { type: 'string', required: true },
                },
            },
            render: (_args, value) => text(value),
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            await store.ensureInit();
            exec.signal?.throwIfAborted();
            const empty = { found: false, id: args.id, page: null, inbound: [], sources: [], truncated: false, note: '' };
            if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(args.id)) {
                return { ...empty, note: 'invalid page id' };
            }
            const page = await store.read(args.id);
            if (page === undefined) {
                return { ...empty, note: `no wiki page "${args.id}"` };
            }
            const { pages } = await store.listPages(['concept', 'entity', 'source']);
            const inbound = pages.filter((other) => other.id !== page.id && other.links.some((link) => link.target === page.id)).map((other) => other.id);
            const sourcePages = await Promise.all(page.sources.map(async (sid) => (isValid(sid) ? await store.read(sid) : undefined)));
            const sources = sourcePages.map((sp) => sp === undefined ? { id: 'unresolved', title: 'missing source page', url: null } : { id: sp.id, title: sp.title, url: sp.url ?? null });
            const bodyBytes = Buffer.byteLength(page.body, 'utf8');
            let body = page.body;
            let truncated = false;
            if (bodyBytes > config.maxInspectBytes) {
                body = Buffer.from(page.body, 'utf8').subarray(0, config.maxInspectBytes).toString('utf8');
                truncated = true;
            }
            return {
                found: true,
                id: page.id,
                page: {
                    kind: page.kind,
                    title: page.title,
                    status: page.status,
                    revision: page.revision,
                    created: page.created,
                    updated: page.updated,
                    tags: page.tags,
                    links: page.links.map((link) => ({ target: link.target, ...(link.relation !== undefined ? { relation: link.relation } : {}) })),
                    sources: page.sources,
                    superseded_by: page.supersededBy ?? null,
                    body,
                },
                inbound,
                sources,
                truncated,
                note: truncated ? `body truncated at ${config.maxInspectBytes} bytes` : '',
            };
        },
        presentCall: (args) => ({ card: 'generic', title: `Inspect wiki page ${args.id}`, kind: 'read' }),
    }));
    ctx.tools.register(defineTool({
        name: 'wiki_source_save',
        description: 'Persist raw external material (a web-search result you fetched, a document, a passage) into the wiki Source Layer as evidence for later knowledge. Returns the source id to reference in wiki_mutate create/update sources. Same URL or same content hash deduplicates to the existing id. Sources are raw material; distilled knowledge goes into concept/entity pages.',
        parameters: {
            title: { type: 'string', required: true, description: 'Title of the material (page title, document name).' },
            content: { type: 'string', required: true, description: 'The extracted original text you relied on. Over the byte cap it is truncated and flagged.' },
            url: { type: 'string', description: 'Origin URL when the material has one.' },
            obtained: { type: 'string', description: 'ISO-8601 retrieval time; defaults to now.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string', required: true },
                    deduplicated: { type: 'boolean', required: true },
                    truncated: { type: 'boolean', required: true },
                    bytes: { type: 'integer', required: true },
                    note: { type: 'string', required: true },
                },
            },
            render: (_args, value) => text(value),
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            await store.ensureInit();
            exec.signal?.throwIfAborted();
            const obtained = parseObtained(args.obtained);
            const id = sourceId(args.url, args.title, obtained);
            return await store.withLock(async () => {
                const existing = await store.read(id);
                if (existing !== undefined) {
                    return { id, deduplicated: true, truncated: false, bytes: Buffer.byteLength(existing.body, 'utf8'), note: `source already saved (revision ${existing.revision}); reuse this id in wiki_mutate sources` };
                }
                const hash = `hash:${contentHash(args.content)}`;
                const { pages } = await store.listPages(['source']);
                const twin = pages.find((p) => p.tags.includes(hash) || (args.url !== undefined && p.url === args.url));
                if (twin !== undefined) {
                    return { id: twin.id, deduplicated: true, truncated: false, bytes: Buffer.byteLength(twin.body, 'utf8'), note: `identical content/url already stored as ${twin.id}` };
                }
                let content = args.content;
                let truncated = false;
                if (Buffer.byteLength(content, 'utf8') > config.maxSourceBytes) {
                    content = Buffer.from(content, 'utf8').subarray(0, config.maxSourceBytes).toString('utf8');
                    truncated = true;
                }
                const iso = obtained.toISOString();
                const body = `> ${args.url !== undefined ? `[${escapeMarkdown(args.title)}](${args.url})` : escapeMarkdown(args.title)} · obtained ${iso}\n\n${content}\n`;
                const page = {
                    id,
                    kind: 'source',
                    title: args.title,
                    status: 'active',
                    revision: 1,
                    created: iso,
                    updated: iso,
                    tags: [hash],
                    links: [],
                    sources: [],
                    ...(args.url !== undefined ? { url: args.url } : {}),
                    obtained: iso,
                    body,
                    path: store.pagePath('source', id),
                };
                await store.writePage(page);
                await store.rebuildIndex();
                await store.appendLog([{ ts: iso, op: 'source_save', pages: [id], result: 'applied', ...(truncated ? { note: 'content truncated' } : {}) }]);
                return {
                    id,
                    deduplicated: false,
                    truncated,
                    bytes: Buffer.byteLength(body, 'utf8'),
                    note: `source saved; reference "${id}" in wiki_mutate sources to ground wiki pages in this evidence`,
                };
            });
        },
        presentCall: (args) => ({ card: 'generic', title: `Save wiki source: ${args.title}`, kind: 'edit' }),
    }));
    ctx.tools.register(defineTool({
        name: 'wiki_mutate',
        description: MUTATION_NOTE,
        parameters: {
            operations: {
                type: 'array',
                required: true,
                description: 'Ordered operations; each fails independently.',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        op: { type: 'string', required: true, enum: ['create', 'update', 'merge', 'link', 'deprecate'], description: 'Mutation kind.' },
                        id: { type: 'string', description: 'create: optional slug hint. update/link/merge/deprecate: the subject page id.' },
                        kind: { type: 'string', enum: ['concept', 'entity'], description: 'create only. Default concept.' },
                        title: { type: 'string', description: 'create: required. update: optional rename.' },
                        body: { type: 'string', description: 'create: required full body. update: full replacement body.' },
                        status: { type: 'string', enum: ['active', 'deprecated', 'merged'], description: 'update only: explicit status change.' },
                        tags: { type: 'array', items: { type: 'string' }, description: 'create/update: tags (update merges).' },
                        links: { type: 'array', items: { type: 'string' }, description: 'create/update: "target" or "target | relation" entries (update merges).' },
                        sources: { type: 'array', items: { type: 'string' }, description: 'create/update: source page ids from wiki_source_save (update merges).' },
                        into_id: { type: 'string', description: 'merge: destination page id.' },
                        to_id: { type: 'string', description: 'link: destination page id.' },
                        relation: { type: 'string', description: 'link: relation label, e.g. "depends on".' },
                        reason: { type: 'string', description: 'deprecate: why the knowledge no longer holds.' },
                        superseded_by: { type: 'string', description: 'deprecate: replacement page id.' },
                        admission: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                reusability: { type: 'integer', required: true, description: '0..3 — will future tasks reuse this?' },
                                stability: { type: 'integer', required: true, description: '0..3 — valid over weeks/months?' },
                                novelty: { type: 'integer', required: true, description: '0..3 — adds what the wiki lacks?' },
                                abstraction: { type: 'integer', required: true, description: '0..3 — a summary, not an event log?' },
                            },
                            description: 'create only, REQUIRED. Admission Controller scores; weak candidates are rejected and journaled.',
                        },
                        note: { type: 'string', description: 'Free-form note journaled into logs/.' },
                    },
                },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    results: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                index: { type: 'integer', required: true },
                                op: { type: 'string', required: true },
                                id: { type: 'string', required: true },
                                status: { type: 'string', required: true },
                                detail: { type: 'string', required: true },
                            },
                        },
                    },
                    applied: { type: 'integer', required: true },
                    rejected: { type: 'integer', required: true },
                    index_rebuilt: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => text(value),
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            await store.ensureInit();
            exec.signal?.throwIfAborted();
            const outcome = await mutator.apply(args.operations);
            return {
                results: outcome.results.map((result) => ({
                    index: result.index,
                    op: result.op,
                    id: result.id,
                    status: result.status,
                    detail: result.detail ?? '',
                })),
                applied: outcome.applied,
                rejected: outcome.rejected,
                index_rebuilt: outcome.indexRebuilt,
            };
        },
        presentCall: (args) => ({ card: 'generic', title: `Wiki mutation (${args.operations.length} op${args.operations.length === 1 ? '' : 's'})`, kind: 'edit' }),
    }));
    ctx.tools.register(defineTool({
        name: 'wiki_lint',
        description: 'Run deterministic quality checks over the wiki: duplicate pages, broken links, stale knowledge, orphan pages, links to deprecated/merged pages, oversize pages, and unparseable files. Report-only — fix findings through wiki_mutate. Run after mutation batches and before trusting an old wiki section.',
        parameters: {
            include_info: { type: 'boolean', description: 'Include info-level findings (default true). Set false for warnings only.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    scanned: { type: 'integer', required: true },
                    warn: { type: 'integer', required: true },
                    info: { type: 'integer', required: true },
                    issues: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                check: { type: 'string', required: true },
                                level: { type: 'string', required: true },
                                page: { type: 'string', required: true },
                                message: { type: 'string', required: true },
                            },
                        },
                    },
                    parse_failures: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                message: { type: 'string', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => text(value),
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            await store.ensureInit();
            exec.signal?.throwIfAborted();
            const report = await lintWiki(store, config);
            const showInfo = args.include_info ?? true;
            const issues = report.issues.filter((issue) => showInfo || issue.level === 'warn');
            return {
                scanned: report.scanned,
                warn: report.counts.warn,
                info: report.counts.info,
                issues: issues.map((issue) => ({ check: issue.check, level: issue.level, page: issue.page, message: issue.message })),
                parse_failures: report.parseFailures.map((failure) => ({ path: failure.path, message: failure.message })),
            };
        },
        presentCall: () => ({ card: 'generic', title: 'Lint wiki', kind: 'search' }),
    }));
}
function isValid(id) {
    try {
        assertPageId(id);
        return true;
    }
    catch {
        return false;
    }
}
function parseObtained(raw) {
    if (raw === undefined || raw.trim().length === 0)
        return new Date();
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime()))
        throw new Error(`obtained must be an ISO-8601 timestamp (got ${JSON.stringify(raw)})`);
    return parsed;
}
function escapeMarkdown(value) {
    return value.replaceAll(/[[\]\\]/g, '\\$&');
}
//# sourceMappingURL=wiki-tools.js.map