import { defineTool } from '@deepseek-ai/dsh-tools';
import { assertPageId, slugifyTitle, sourceId } from '../storage/id-slug.js';
import { StagingQueue } from '../storage/staging.js';
import { searchWiki } from '../retrieval/grep-retriever.js';
import { routeQuery } from '../router/knowledge-router.js';
import { assertAdmissionScores, evaluateAdmission } from '../mutation/admission.js';
import { clampInline, renderApprovalPitch, renderOpPitch, renderSourcePitch } from '../mutation/pitch.js';
import { GUIDE_TOPICS, observeStaging, observeWiki, readPlaybook } from '../prompt.js';
import { lintWiki } from '../validator/wiki-linter.js';
function text(value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}
/** Why a gated write did not land, phrased so the model stops retrying. */
function approvalNote(outcome) {
    switch (outcome) {
        case 'rejected':
            return 'the user declined this batch — leave it out rather than asking again';
        case 'cancelled':
            return 'the approval prompt was cancelled (the turn ended) — do not retry';
        default:
            return 'no approval channel is available and "never" policies reject automatically — leave the knowledge out of this turn';
    }
}
/** Compact review row: what a staged entry is, plus the pitch the user sees. */
function summarizeStaged(entry, index) {
    const target = entry.type === 'source'
        ? String(entry.payload.url ?? entry.payload.title ?? '')
        : String(entry.payload.id ?? entry.payload.title ?? '');
    return {
        index,
        id: entry.id,
        kind: entry.type === 'source' ? 'source' : entry.payload.kind ?? 'concept',
        op: entry.type === 'source' ? 'source_save' : entry.payload.op,
        target: clampInline(target, 80),
        pitch: entry.pitch,
        reason: entry.reason ?? '',
    };
}
/** Origin host of a source card, for a provenance hint that fits one line. */
function urlHost(url) {
    if (url === undefined)
        return '';
    try {
        return new URL(url).host;
    }
    catch {
        return '';
    }
}
/**
 * Name one staged entry the way a person scanning an approval prompt reads it:
 * the title they wrote, not the slug, and only the origin's host rather than
 * its whole URL. `renderApprovalPitch` shapes these into the prompt itself.
 */
function approvalLineFor(entry) {
    if (entry.type === 'source') {
        const payload = entry.payload;
        const host = urlHost(payload.url);
        const label = [payload.title ?? payload.url ?? '(untitled)', host].filter((part) => part.length > 0).join(' @ ');
        return { op: 'SOURCE', label, reason: entry.reason ?? '' };
    }
    const op = entry.payload;
    const id = op.id ?? '(derived id)';
    const label = op.op === 'create'
        ? (op.title ?? id)
        : (op.op === 'merge' || op.op === 'link')
            ? `${id} → ${op.into_id ?? op.to_id ?? '(missing target)'}`
            : id;
    return { op: String(op.op).toUpperCase(), label, reason: op.why ?? entry.reason ?? '' };
}
/** Ask the harness approval seam. A missing seam counts as `unavailable`. */
async function askApproval(ctx, toolName, reason, extras, fallback) {
    const seam = ctx.get?.('approval', false);
    if (seam === undefined || typeof seam.request !== 'function' || extras?.agent === undefined)
        return fallback;
    try {
        return await seam.request({
            agent: extras.agent,
            toolName,
            ...(extras.callId !== undefined ? { callId: extras.callId } : {}),
            ...(extras.signal !== undefined ? { signal: extras.signal } : {}),
            reason,
        });
    }
    catch (error) {
        ctx.logger?.warn?.('dsh-llm-wiki: approval request failed for %s: %s', toolName, error instanceof Error ? error.message : String(error));
        return 'unavailable';
    }
}
/** One line telling the model what just happened to its gated writes. */
function gateNote(pending) {
    return `nothing written to the live wiki yet: ${pending} proposal(s) waiting in staging/ — present them to the user with their reasons, then call wiki_review to promote or discard them (approval: "staging")`;
}
/** Keep the runtime-context state line current. Never throws. */
async function refreshCounts(store, staging, stats, logger) {
    try {
        observeWiki(stats, (await store.listIds(['concept', 'entity'])).size, (await staging.list()).entries.length);
    }
    catch (error) {
        logger?.warn?.('dsh-llm-wiki: prompt stats refresh failed: %s', error instanceof Error ? error.message : String(error));
    }
}
const MUTATION_NOTE = 'Incremental wiki mutation. Batch ALL of a task\'s knowledge changes in one call. Ops: ' +
    'create (needs admission {reusability,stability,novelty,abstraction} 0..3 — the Admission Controller rejects weak candidates); ' +
    'update (body replaces; tags/links/sources merge); ' +
    'merge (id -> into_id; the weaker id becomes a redirect stub); ' +
    'link (id -> to_id, optional relation); ' +
    'deprecate (keep for history, optionally superseded_by). ' +
    'Prefer update over create, link over prose duplication, deprecate over deletion. ' +
    'Link entries are "target" or "target | relation"; sources reference wiki_source_save ids. ' +
    'Add "why" (1-2 sentences) so the user reviewing the proposal can judge it: with the default ' +
    'wiki.approval="staging" nothing is written until the user approves it through wiki_review. ' +
    'Each op reports applied/noop/rejected/error independently.';
export function registerWikiTools(ctx, store, mutator, config, stats = { pages: 0, pending: 0 }) {
    const staging = new StagingQueue(store.root);
    const gated = config.approval !== 'off';
    /**
     * Record one source card in the Source Layer.
     *
     * A card is provenance, never storage. It keeps the title, the origin link
     * and the retrieval time; the original text stays on the web. The knowledge
     * the model took away lives in the concept/entity pages that cite this id,
     * so a card costs a few hundred bytes however enormous the page behind it.
     * Idempotent on the id (title + day) and on the URL.
     */
    async function saveSource(id, input) {
        return await store.withLock(async () => {
            const existing = await store.read(id);
            if (existing !== undefined) {
                return { id, staged_as: '', staged: false, deduplicated: true, bytes: Buffer.byteLength(existing.body, 'utf8'), note: `source already recorded (revision ${existing.revision}); reuse this id in wiki_mutate sources` };
            }
            if (input.url !== undefined) {
                const { pages } = await store.listPages(['source']);
                const twin = pages.find((page) => page.url === input.url);
                if (twin !== undefined) {
                    return { id: twin.id, staged_as: '', staged: false, deduplicated: true, bytes: Buffer.byteLength(twin.body, 'utf8'), note: `this url is already recorded as ${twin.id}; reuse that id in wiki_mutate sources` };
                }
            }
            const label = input.url !== undefined ? `[${escapeMarkdown(input.title)}](${input.url})` : escapeMarkdown(input.title);
            const body = `> ${label} · obtained ${input.obtained}\n\n> Source card. The original text is not stored here: re-fetch the link when a claim grounded in it needs re-checking.\n`;
            const page = {
                id,
                kind: 'source',
                title: input.title,
                status: 'active',
                revision: 1,
                created: input.obtained,
                updated: input.obtained,
                tags: [],
                links: [],
                sources: [],
                ...(input.url !== undefined ? { url: input.url } : {}),
                obtained: input.obtained,
                body,
                path: store.pagePath('source', id),
            };
            await store.writePage(page);
            await store.rebuildIndex();
            await store.appendLog([{ ts: input.obtained, op: 'source_save', pages: [id], result: 'applied' }]);
            await refreshCounts(store, staging, stats, ctx.logger);
            return { id, staged_as: '', staged: false, deduplicated: false, bytes: Buffer.byteLength(body, 'utf8'), note: `source recorded as a link card; reference "${id}" in wiki_mutate sources to ground wiki pages in this evidence` };
        });
    }
    ctx.tools.register(defineTool({
        name: 'wiki_search',
        description: 'Search the persistent agent wiki (semantic memory) BEFORE reaching for the web. Returns ranked hits plus a Knowledge Router verdict: coverage (none/low/partial/high), use_wiki, need_web, and advice. Wiki-first: reuse what is covered, fetch only what is missing. Coverage is a heuristic, not a verdict — each hit carries its match evidence (matched/total query terms, strong = title/tag hits); on partial, judge for yourself whether the top page is really your subject. Deprecated pages are excluded unless include_deprecated.',
        parameters: {
            query: { type: 'string', required: true, description: 'Natural-language query; CJK and ASCII both tokenize.' },
            kind: { type: 'string', enum: ['concept', 'entity', 'source'], description: 'Restrict to one page class. Default: concept + entity (sources optional).' },
            limit: { type: 'integer', description: `Max hits (1..50). Default ${config.searchLimit}.` },
            include_deprecated: { type: 'boolean', description: 'Include deprecated pages (scored at half weight). Default false.' },
            include_sources: { type: 'boolean', description: 'Search the Source Layer (source cards: titles, links) as well. Default from plugin config.' },
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
                                match: {
                                    type: 'object',
                                    required: true,
                                    description: 'Coverage evidence behind `score`: weighted query terms matched (matched/total), and how many of those hit the title or tags (strong). Judge relevance from this and the snippet.',
                                    additionalProperties: false,
                                    properties: {
                                        matched: { type: 'number', required: true },
                                        total: { type: 'number', required: true },
                                        strong: { type: 'number', required: true },
                                    },
                                },
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
                    next_step: { type: 'string', required: true, description: 'The concrete call(s) this verdict points at; on partial it branches on your judgement of the top hit.' },
                    guide_topic: { type: 'string', required: true, description: 'wiki_guide topic holding the detail this verdict needs.' },
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
            await refreshCounts(store, staging, stats, ctx.logger);
            return {
                hits: result.hits.map((hit) => ({
                    id: hit.id,
                    kind: hit.kind,
                    title: hit.title,
                    status: hit.status,
                    score: hit.score,
                    match: hit.match,
                    freshness: hit.freshness,
                    snippet: hit.snippet,
                    updated: hit.updated,
                })),
                coverage: decision.coverage,
                use_wiki: decision.useWiki,
                need_web: decision.needWeb,
                advice: decision.advice,
                next_step: decision.nextStep,
                guide_topic: decision.guideTopic,
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
        description: 'Record where external material came from: one Source Layer card holding the title, the origin URL and the retrieval time. The original text is NEVER stored here — do not paste page content; the wiki keeps no raw material. What you learned from the material belongs in concept/entity pages, which cite the id this call returns. Same URL deduplicates to the existing card. With the default write gate this only proposes: the entry waits in staging/ for the user.',
        parameters: {
            title: { type: 'string', required: true, description: 'Title of the material (page title, document name).' },
            url: { type: 'string', description: 'Origin URL. Strongly encouraged: it is the whole point of the card. A card without one only records that you consulted something called `title`.' },
            obtained: { type: 'string', description: 'ISO-8601 retrieval time; defaults to now.' },
            why: { type: 'string', description: '1-2 sentences on why this material deserves a place in the wiki. Shown verbatim to the user when the write gate asks for approval.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string', required: true, description: 'Live source id (what wiki_mutate sources will reference).' },
                    staged_as: { type: 'string', required: true, description: 'Pending id when the write gate held this proposal; empty when it was written or deduplicated.' },
                    staged: { type: 'boolean', required: true, description: 'True when the entry waits in staging/ for the user.' },
                    deduplicated: { type: 'boolean', required: true },
                    bytes: { type: 'integer', required: true, description: 'Size of the card this call produced (a link card is a few hundred bytes).' },
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
            const payload = { title: args.title, obtained: obtained.toISOString(), ...(args.url !== undefined ? { url: args.url } : {}) };
            const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
            if (gated) {
                const pitch = renderSourcePitch(args.title, args.url);
                if (config.approval === 'inline') {
                    const outcome = await askApproval(ctx, 'wiki_source_save', pitch, exec, 'unavailable');
                    if (outcome !== 'allowed-once') {
                        return { id, staged_as: '', staged: false, deduplicated: false, bytes, note: approvalNote(outcome) };
                    }
                    return await saveSource(id, payload);
                }
                const entry = await staging.put({
                    kind: 'source',
                    type: 'source',
                    payload,
                    pitch,
                    ...(args.why !== undefined ? { reason: args.why } : {}),
                });
                await refreshCounts(store, staging, stats, ctx.logger);
                return { id, staged_as: entry.id, staged: true, deduplicated: false, bytes, note: `held for your review; ${gateNote(stats.pending)} — once approved, reference "${id}" in wiki_mutate sources` };
            }
            return await saveSource(id, payload);
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
                        why: { type: 'string', description: '1-2 sentences on why this change is worth keeping. Shown to the user when the write gate asks for approval (falls back to note).' },
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
                                status: { type: 'string', required: true, description: 'applied | noop | rejected | error | staged.' },
                                detail: { type: 'string', required: true },
                                staged: { type: 'boolean', required: true },
                                staged_as: { type: 'string', required: true, description: 'Pending id when the write gate held this op; empty otherwise.' },
                            },
                        },
                    },
                    applied: { type: 'integer', required: true },
                    rejected: { type: 'integer', required: true },
                    staged: { type: 'integer', required: true, description: 'Ops held in staging/ awaiting the user.' },
                    pending_total: { type: 'integer', required: true, description: 'All entries now waiting in staging/.' },
                    index_rebuilt: { type: 'boolean', required: true },
                    note: { type: 'string', required: true },
                },
            },
            render: (_args, value) => text(value),
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            await store.ensureInit();
            exec.signal?.throwIfAborted();
            const ops = args.operations;
            if (gated && config.approval === 'inline') {
                const outcome = await askApproval(ctx, 'wiki_mutate', `${ops.length} wiki change(s):\n${ops.map((op, index) => `(${(index + 1).toString()}) ${renderOpPitch(op)}`).join('\n')}`, exec, 'unavailable');
                if (outcome !== 'allowed-once') {
                    const why = approvalNote(outcome);
                    return {
                        results: ops.map((op, index) => ({ index, op: op.op, id: op.id ?? 'unknown', status: 'rejected', staged: false, staged_as: '', detail: why })),
                        applied: 0,
                        rejected: ops.length,
                        staged: 0,
                        pending_total: 0,
                        index_rebuilt: false,
                        note: why,
                    };
                }
            }
            if (gated && config.approval === 'staging') {
                const rows = [];
                let rejected = 0;
                for (const [index, op] of ops.entries()) {
                    const why = op.why;
                    const id = op.id ?? (op.title !== undefined ? slugifyTitle(op.title) : 'unknown');
                    const bytes = Buffer.byteLength(JSON.stringify(op), 'utf8');
                    const refuse = (status, detail) => {
                        rows.push({ index, op: op.op, id, status, staged: false, staged_as: '', detail });
                        rejected++;
                    };
                    if (bytes > config.maxStagedBytes) {
                        refuse('rejected', `payload is ${bytes} bytes, over maxStagedBytes ${config.maxStagedBytes} — condense the page before proposing it`);
                        continue;
                    }
                    let admission;
                    if (op.op === 'create') {
                        if (op.admission === undefined) {
                            refuse('rejected', 'create requires admission scores: {reusability, stability, novelty, abstraction}, each 0..3');
                            continue;
                        }
                        try {
                            const verdict = evaluateAdmission(assertAdmissionScores(op.admission), config);
                            if (!verdict.accept) {
                                refuse('rejected', `admission rejected (${verdict.reasons.join('; ')}); if this belongs with an existing page use update/merge instead`);
                                continue;
                            }
                            admission = { average: verdict.average, minimum: verdict.minimum, accept: verdict.accept };
                        }
                        catch (error) {
                            refuse('error', error instanceof Error ? error.message : String(error));
                            continue;
                        }
                    }
                    const entry = await staging.put({
                        kind: op.kind ?? 'concept',
                        type: 'mutation',
                        payload: op,
                        pitch: renderOpPitch(op),
                        ...(why !== undefined || op.note !== undefined ? { reason: why ?? op.note } : {}),
                        ...(op.admission !== undefined ? { scores: { ...op.admission } } : {}),
                        ...(admission !== undefined ? { admission } : {}),
                    });
                    rows.push({ index, op: op.op, id, status: 'staged', staged: true, staged_as: entry.id, detail: entry.pitch });
                }
                const pendingTotal = (await staging.list()).entries.length;
                observeStaging(stats, pendingTotal);
                const note = rows.length === 0 ? 'nothing to stage' : gateNote(pendingTotal);
                return {
                    results: rows,
                    applied: 0,
                    rejected,
                    staged: rows.filter((row) => row.status === 'staged').length,
                    pending_total: pendingTotal,
                    index_rebuilt: false,
                    note,
                };
            }
            const outcome = await mutator.apply(ops);
            await refreshCounts(store, staging, stats, ctx.logger);
            return {
                results: outcome.results.map((result) => ({
                    index: result.index,
                    op: result.op,
                    id: result.id,
                    status: result.status,
                    staged: false,
                    staged_as: '',
                    detail: result.detail ?? '',
                })),
                applied: outcome.applied,
                rejected: outcome.rejected,
                staged: 0,
                pending_total: stats.pending,
                index_rebuilt: outcome.indexRebuilt,
                note: outcome.applied > 0 ? `${outcome.applied} op(s) applied to the live wiki` : 'no op applied',
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
    ctx.tools.register(defineTool({
        name: 'wiki_guide',
        description: 'Fetch one DSH-Wiki playbook verbatim when a one-line rule is not enough: router (how coverage routes between the wiki and the web), extraction (turning fetched material into admitted knowledge), mutation (op semantics and the rules of the layer), validation (fixing lint findings). Only the compact core lives in the system prompt; the detail is here on demand.',
        parameters: {
            topic: { type: 'string', enum: ['router', 'extraction', 'mutation', 'validation'], required: true, description: 'Which playbook to return.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    topic: { type: 'string', required: true },
                    found: { type: 'boolean', required: true },
                    playbook: { type: 'string', required: true, description: 'The playbook markdown; empty when unreadable.' },
                    topics: { type: 'array', required: true, items: { type: 'string' }, description: 'All available topics.' },
                    note: { type: 'string', required: true },
                },
            },
            render: (_args, value) => text(value),
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            exec.signal?.throwIfAborted();
            const playbook = await readPlaybook(args.topic);
            return {
                topic: args.topic,
                found: playbook !== undefined,
                playbook: playbook ?? '',
                topics: [...GUIDE_TOPICS],
                note: playbook !== undefined ? '' : `playbook "${args.topic}" is unreadable in this installation; follow the core rules in the system prompt`,
            };
        },
        presentCall: (args) => ({ card: 'generic', title: `Wiki guide: ${args.topic}`, kind: 'read' }),
    }));
    ctx.tools.register(defineTool({
        name: 'wiki_review',
        description: 'The user-facing half of the write gate. With the default wiki.approval="staging" nothing you write is live: wiki_source_save and wiki_mutate park proposals in staging/. Call wiki_review to put the pending proposals in front of the user with their reasons and act on the answer. action "list" shows them without deciding; "promote" (default) asks the user once and applies the approved set through the normal admission/mutation path; "discard" drops proposals without writing. Omit ids to cover everything pending. Promoted sources and pages become visible to wiki_search and wiki_lint. A declined or cancelled review discards the proposals it covered.',
        parameters: {
            ids: { type: 'array', items: { type: 'string' }, description: 'Pending ids to act on (returned by wiki_source_save / wiki_mutate). Default: everything pending.' },
            action: { type: 'string', enum: ['list', 'promote', 'discard'], description: 'list: read-only inventory, no prompt. promote: default. discard: drop without writing, no prompt.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    pending_total: { type: 'integer', required: true, description: 'Entries still waiting after this call.' },
                    pending: {
                        type: 'array',
                        required: true,
                        description: 'The rows this call looked at, oldest first — show these to the user.',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                index: { type: 'integer', required: true },
                                id: { type: 'string', required: true },
                                kind: { type: 'string', required: true },
                                op: { type: 'string', required: true },
                                target: { type: 'string', required: true },
                                pitch: { type: 'string', required: true },
                                reason: { type: 'string', required: true, description: 'Why the extracting agent thought this deserved a place in the wiki.' },
                            },
                        },
                    },
                    results: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', required: true },
                                status: { type: 'string', required: true },
                                detail: { type: 'string', required: true },
                            },
                        },
                    },
                    promoted: { type: 'integer', required: true },
                    discarded: { type: 'integer', required: true, description: 'Entries removed from staging/ without being written: an explicit "discard", or a review the user declined or cancelled.' },
                    applied: { type: 'integer', required: true },
                    rejected: { type: 'integer', required: true },
                    unknown_ids: { type: 'array', required: true, items: { type: 'string' } },
                    note: { type: 'string', required: true },
                },
            },
            render: (_args, value) => text(value),
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            await store.ensureInit();
            exec.signal?.throwIfAborted();
            const action = args.action ?? 'promote';
            const { entries: all } = await staging.list();
            const wanted = args.ids;
            const selected = wanted !== undefined ? all.filter((entry) => wanted.includes(entry.id)) : all;
            const unknownIds = wanted === undefined ? [] : wanted.filter((id) => !all.some((entry) => entry.id === id));
            const rows = selected.map((entry, index) => ({ ...summarizeStaged(entry, index) }));
            observeStaging(stats, all.length);
            const inventory = {
                pending_total: all.length,
                pending: rows,
                unknown_ids: unknownIds,
                promoted: 0,
                discarded: 0,
                applied: 0,
                rejected: 0,
                results: [],
            };
            if (selected.length === 0) {
                return { ...inventory, note: all.length === 0 ? 'staging/ is empty — nothing is waiting' : 'none of the given ids are pending (already promoted, discarded, or misspelled)' };
            }
            if (action === 'list') {
                return { ...inventory, note: 'present these to the user with their reasons, then call wiki_review again with the ids they approved' };
            }
            if (action === 'discard') {
                await staging.drop(selected.map((entry) => entry.id));
                await refreshCounts(store, staging, stats, ctx.logger);
                return { ...inventory, discarded: selected.length, pending_total: stats.pending, note: 'dropped without writing anything to the wiki' };
            }
            const pitch = renderApprovalPitch(selected.map(approvalLineFor));
            const outcome = await askApproval(ctx, 'wiki_review', pitch, exec, 'unavailable');
            // A declined review is a verdict on the content, not a pause. The user said this
            // does not belong in the wiki, so the proposals they were shown are dropped rather
            // than left to ride into the next review bundled with unrelated material — a page
            // is cheap to re-derive (one web search plus a summary), a stale queue taxes the
            // user's attention every session and risks being waved through by accident.
            if (outcome === 'rejected' || outcome === 'cancelled') {
                const ids = selected.map((entry) => entry.id);
                await staging.drop(ids);
                const verdict = outcome === 'rejected' ? 'declined by the user' : 'approval cancelled';
                await store.appendLog([{ ts: new Date().toISOString(), op: 'review', pages: ids, result: `${verdict}: ${ids.length.toString()} proposal(s) discarded from staging/` }]);
                await refreshCounts(store, staging, stats, ctx.logger);
                return {
                    ...inventory,
                    discarded: ids.length,
                    pending_total: stats.pending,
                    note: `${approvalNote(outcome)} — discarded ${ids.length.toString()} proposal(s) from staging/, so there is nothing left waiting. Re-propose only if the knowledge turns out to be needed again.`,
                };
            }
            if (outcome !== 'allowed-once') {
                // `unavailable`: nobody ever saw the proposals, so there is no decision to
                // honour — keeping them is the only honest option.
                return { ...inventory, note: `${approvalNote(outcome)} (proposals stay in staging/ and can be reviewed again later)` };
            }
            const results = [];
            let applied = 0;
            let rejected = 0;
            // Sources first: a promoted page may ground itself in a source promoted in the same review.
            for (const entry of selected.filter((item) => item.type === 'source')) {
                const payload = entry.payload;
                try {
                    const saved = await saveSource(sourceId(payload.url, payload.title, parseObtained(payload.obtained)), payload);
                    results.push({ id: entry.id, status: saved.deduplicated ? 'noop' : 'applied', detail: saved.note });
                    applied++;
                }
                catch (error) {
                    results.push({ id: entry.id, status: 'error', detail: error instanceof Error ? error.message : String(error) });
                    rejected++;
                }
            }
            for (const entry of selected.filter((item) => item.type === 'mutation')) {
                const op = entry.payload;
                const outcomeOfOne = await mutator.apply([op]);
                const row = outcomeOfOne.results[0];
                results.push({ id: entry.id, status: row?.status ?? 'error', detail: row?.detail ?? 'no result' });
                if (row !== undefined && row.status === 'applied')
                    applied++;
                else
                    rejected++;
            }
            await staging.drop(selected.map((entry) => entry.id));
            await store.appendLog([{ ts: new Date().toISOString(), op: 'review', pages: selected.map((entry) => entry.id), result: `${applied} applied / ${rejected} not applied` }]);
            await refreshCounts(store, staging, stats, ctx.logger);
            return {
                ...inventory,
                results,
                promoted: selected.length,
                applied,
                rejected,
                pending_total: stats.pending,
                note: `${applied} of ${selected.length} proposal(s) are now live; ${rejected} not applied (each reason is in results)`,
            };
        },
        presentCall: (args) => ({ card: 'generic', title: `Review wiki proposals (${args.action ?? 'promote'})`, kind: 'edit' }),
    }));
    return {
        /** The live snapshot the prompt section reads. */
        stats,
        /** Recompute page/pending counts after startup initialization or out-of-band edits. */
        refresh: () => refreshCounts(store, staging, stats, ctx.logger),
    };
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