import { assertPageId, isValidPageId, slugifyTitle } from '../storage/id-slug.js';
import { assertAdmissionScores, evaluateAdmission } from './admission.js';
import { WikiGraph } from '../graph/graph.js';
import { graphOptionsOf, checksFor } from '../validator/checks.js';
import { suggestNeighbors } from '../graph/suggest.js';
/** Ids a write may point at: what is on disk, plus what this batch creates. */
class WriteScope {
    known;
    promised;
    constructor(known, promised) {
        this.known = new Set(known);
        this.promised = new Set(promised);
    }
    exists(id) {
        return this.known.has(id) || this.promised.has(id);
    }
    /** Declared targets no page answers, now or by the end of this batch. */
    missing(links) {
        return links.filter((link) => !this.exists(link.target));
    }
}
function nowIso() {
    return new Date().toISOString();
}
function parseLinkEntries(entries, selfId) {
    const out = [];
    for (const raw of entries) {
        const text = raw.trim();
        if (text.length === 0)
            continue;
        const bar = text.indexOf('|');
        const target = (bar < 0 ? text : text.slice(0, bar)).trim();
        const relation = bar < 0 ? undefined : text.slice(bar + 1).trim();
        if (!isValidPageId(target))
            throw new Error(`bad link target ${JSON.stringify(target)}`);
        if (target === selfId)
            throw new Error(`page ${selfId} cannot link to itself`);
        const link = { target };
        if (relation !== undefined && relation.length > 0)
            link.relation = relation;
        out.push(link);
    }
    return out;
}
function sameLink(a, b) {
    return a.target === b.target && (a.relation ?? '') === (b.relation ?? '');
}
function unionLinks(existing, added) {
    const out = [...existing];
    for (const link of added)
        if (!out.some((e) => sameLink(e, link)))
            out.push(link);
    return out;
}
function unionList(existing, added) {
    return [...new Set([...existing, ...added])].sort();
}
function textValue(raw, field, required) {
    if (raw === undefined || raw === null) {
        if (required)
            throw new Error(`${field} is required`);
        return undefined;
    }
    if (typeof raw !== 'string')
        throw new Error(`${field} must be a string`);
    return raw;
}
/** The id a create op will land on, or undefined when the op cannot be named yet. */
function createdId(op) {
    if (op.op !== 'create')
        return undefined;
    if (op.id !== undefined)
        return op.id;
    if (typeof op.title !== 'string' || op.title.trim().length === 0)
        return undefined;
    return slugifyTitle(op.title);
}
function describeLinks(links) {
    return links.map((link) => (link.relation === undefined ? `"${link.target}"` : `"${link.target}" (${link.relation})`)).join(', ');
}
export class Mutator {
    store;
    config;
    constructor(store, config) {
        this.store = store;
        this.config = config;
    }
    /** Apply a batch of operations. One bad operation fails only itself. */
    async apply(ops) {
        return await this.store.withLock(async () => {
            const promised = new Set();
            for (const raw of ops) {
                const id = createdId(raw);
                if (id !== undefined)
                    promised.add(id);
            }
            const onDisk = await this.store.listIds();
            const results = [];
            const entries = [];
            const touched = new Set();
            let applied = 0;
            let rejected = 0;
            for (const [index, raw] of ops.entries()) {
                const op = raw;
                let result;
                try {
                    result = await this.applyOne(op, index, entries, new WriteScope(onDisk.keys(), promised));
                }
                catch (error) {
                    result = {
                        index,
                        op: op.op,
                        id: op.id ?? 'unknown',
                        status: 'error',
                        detail: error instanceof Error ? error.message : String(error),
                    };
                }
                results.push(result);
                if (result.status === 'applied') {
                    applied++;
                    for (const id of resultPages(op, result))
                        touched.add(id);
                }
                if (result.status === 'rejected' || result.status === 'error')
                    rejected++;
            }
            let indexRebuilt = false;
            let pages = [];
            if (applied > 0) {
                pages = (await this.store.listPages()).pages;
                await this.store.rebuildIndex(pages);
                indexRebuilt = true;
            }
            if (this.config.mutationLog && entries.length > 0)
                await this.store.appendLog(entries);
            const graph = await this.graphOf(pages);
            const feedback = await this.feedback(graph, touched, false);
            return { results, applied, rejected, indexRebuilt, graph: feedback };
        });
    }
    /**
     * What the graph would look like if this batch were applied, without writing
     * anything. The write gate parks most batches in `staging/`, so the same
     * feedback has to be legible at proposal time too — an edge that will dangle
     * is worth naming before the user ever sees the pitch.
     */
    async previewGraph(ops) {
        const graph = await this.graphOf();
        const promised = new Set();
        for (const raw of ops) {
            const id = createdId(raw);
            if (id !== undefined)
                promised.add(id);
        }
        const scope = new WriteScope(graph.pages.map((page) => page.id), promised);
        const subjects = [];
        const dangling = [];
        const notes = [];
        for (const raw of ops) {
            const op = raw;
            const id = createdId(op) ?? op.id;
            if (id === undefined)
                continue;
            if (op.links !== undefined) {
                let links;
                try {
                    links = parseLinkEntries(op.links, id);
                }
                catch {
                    continue; // a malformed entry is the tool's error to report, not this one's
                }
                for (const link of scope.missing(links)) {
                    const edge = { page: id, target: link.target, kind: 'link' };
                    if (link.relation !== undefined)
                        edge.relation = link.relation;
                    dangling.push(edge);
                }
            }
            if (op.op === 'create' || op.op === 'update') {
                const existing = graph.get(id);
                subjects.push({
                    id,
                    title: op.title ?? existing?.title ?? id,
                    tags: op.tags ?? existing?.tags ?? [],
                    body: op.body ?? existing?.body ?? '',
                });
            }
        }
        const suggestions = this.suggestFor(graph, subjects);
        for (const edge of dangling) {
            notes.push(`${edge.page} links to "${edge.target}", which does not exist${this.config.linkTargetCheck === 'strict' ? ' — strict mode will refuse this write' : '; create the page or drop the link'}`);
        }
        for (const entry of suggestions) {
            if (entry.candidates.length === 0 && !graph.has(entry.id))
                notes.push(`${entry.id} is a new page with no candidate neighbour yet — it starts life unlinked`);
        }
        return { stats: graph.stats(), dangling, suggestions, findings: [], notes, preview: true };
    }
    /** Rebuild the derived graph over the corpus (pass `pages` to reuse a listing). */
    async graphOf(pages) {
        const loaded = pages ?? (await this.store.listPages()).pages;
        return WikiGraph.fromPages(loaded, graphOptionsOf(this.config));
    }
    /** Nominated links for one existing page, over a graph the caller already has. */
    suggestionsFor(page, graph) {
        if (page.kind === 'source')
            return [];
        return this.suggestFor(graph, [{ id: page.id, title: page.title, tags: page.tags, body: page.body }])[0]?.candidates ?? [];
    }
    suggestFor(graph, subjects) {
        if (!this.config.linkSuggest)
            return [];
        const out = [];
        for (const subject of subjects) {
            const candidates = suggestNeighbors(graph, subject, {
                limit: this.config.linkSuggestLimit,
                minScore: this.config.linkSuggestMinScore,
                agingAfterDays: this.config.agingAfterDays,
                staleAfterDays: this.config.staleAfterDays,
            });
            out.push({ id: subject.id, candidates });
        }
        return out;
    }
    /** Assemble the write-result graph feedback over a fresh graph. */
    async feedback(graph, touched, preview) {
        const stats = graph.stats();
        if (touched.size === 0)
            return { stats, dangling: [], suggestions: [], findings: [], notes: [], preview };
        const touchedPages = graph.pages.filter((page) => touched.has(page.id));
        // `off` means the write path has no opinion about link targets at all.
        const dangling = this.config.linkTargetCheck === 'off' ? [] : graph.danglingEdges().filter((edge) => touched.has(edge.page));
        const findings = checksFor(graph, this.config, touchedPages);
        const subjects = touchedPages.filter((page) => page.kind !== 'source').map((page) => ({ id: page.id, title: page.title, tags: page.tags, body: page.body }));
        const suggestions = this.suggestFor(graph, subjects);
        const notes = [];
        for (const page of touchedPages) {
            if (page.kind === 'source' || page.status !== 'active')
                continue;
            if (graph.knowledgeOutbound(page.id) === 0) {
                notes.push(`${page.id} now has no outgoing edge: it is only reachable if something links to it`);
            }
            if (graph.knowledgeInbound(page.id) === 0 && suggestions.find((entry) => entry.id === page.id)?.candidates.length === 0) {
                notes.push(`${page.id} is not reachable from any page and no candidate neighbour scored — link it deliberately or merge it into one`);
            }
        }
        for (const edge of dangling) {
            notes.push(`${edge.page} links to "${edge.target}", which does not exist — create the page or drop the link`);
        }
        return { stats, dangling, suggestions, findings, notes, preview };
    }
    log(entries, op, pages, result, detail) {
        const entry = { ts: nowIso(), op: op.op, pages, result };
        if (op.note !== undefined)
            entry.note = op.note;
        if (detail !== undefined)
            entry.note = entry.note === undefined ? detail : `${entry.note} — ${detail}`;
        entries.push(entry);
    }
    async applyOne(op, index, entries, scope) {
        switch (op.op) {
            case 'create':
                return await this.create(op, index, entries, scope);
            case 'update':
                return await this.update(op, index, entries, scope);
            case 'merge':
                return await this.merge(op, index, entries);
            case 'link':
                return await this.link(op, index, entries);
            case 'deprecate':
                return await this.deprecate(op, index, entries);
            default:
                return { index, op: op.op, id: op.id ?? 'unknown', status: 'error', detail: `unknown op ${JSON.stringify(op.op)}` };
        }
    }
    checkBodySize(id, body) {
        const bytes = Buffer.byteLength(body, 'utf8');
        if (bytes > this.config.maxPageBytes) {
            throw new Error(`page ${id} body is ${bytes} bytes, over maxPageBytes ${this.config.maxPageBytes}; split it or condense the text`);
        }
    }
    /**
     * The one standard for a link target, applied to every write path. `off`
     * stays silent; `warn` writes and lets the feedback name the hole; `strict`
     * refuses, so a wiki can be held to "no edge points at nothing".
     */
    checkTargets(id, links, scope) {
        if (this.config.linkTargetCheck === 'off')
            return undefined;
        const missing = scope.missing(links);
        if (missing.length === 0)
            return undefined;
        if (this.config.linkTargetCheck !== 'strict')
            return undefined;
        return `link target(s) do not exist: ${describeLinks(missing)}. Create the target first (ids made by this same batch do count), or drop the link. Set linkTargetCheck to "warn" to write anyway.`;
    }
    async create(op, index, entries, scope) {
        const title = textValue(op.title, 'title', true);
        const body = textValue(op.body, 'body', true);
        const kind = op.kind === 'entity' ? 'entity' : 'concept';
        if (op.admission === undefined) {
            throw new Error('create requires admission scores: {reusability, stability, novelty, abstraction}, each 0..3');
        }
        const scores = assertAdmissionScores(op.admission);
        const verdict = evaluateAdmission(scores, this.config);
        const id = op.id ?? slugifyTitle(title);
        assertPageId(id);
        if (!verdict.accept) {
            this.log(entries, op, [id], 'rejected', `admission: ${verdict.reasons.join('; ')}`);
            return {
                index,
                op: 'create',
                id,
                status: 'rejected',
                detail: `admission rejected (${verdict.reasons.join('; ')}). If this belongs with an existing page, use update/merge instead.`,
            };
        }
        const existing = await this.store.read(id);
        if (existing !== undefined) {
            this.log(entries, op, [id], 'rejected', 'duplicate id');
            return {
                index,
                op: 'create',
                id,
                status: 'rejected',
                detail: `page "${id}" already exists ("${existing.title}"); use op "update" for incremental change instead of re-creating`,
            };
        }
        this.checkBodySize(id, body);
        const links = parseLinkEntries(op.links ?? [], id);
        const refused = this.checkTargets(id, links, scope);
        if (refused !== undefined) {
            this.log(entries, op, [id], 'rejected', refused);
            return { index, op: 'create', id, status: 'rejected', detail: refused };
        }
        const now = nowIso();
        const page = {
            id,
            kind,
            title,
            status: 'active',
            revision: 1,
            created: now,
            updated: now,
            tags: [...new Set(op.tags ?? [])].sort(),
            links,
            sources: [...new Set(op.sources ?? [])].sort(),
            body: body.trimEnd() + '\n',
            path: this.store.pagePath(kind, id),
        };
        for (const source of page.sources)
            assertPageId(source);
        await this.store.writePage(page);
        this.log(entries, op, [id], 'applied', `admission avg ${verdict.average}`);
        return { index, op: 'create', id, status: 'applied', detail: `created ${kind} page (revision 1, admission avg ${verdict.average})` };
    }
    async update(op, index, entries, scope) {
        const id = textValue(op.id, 'id', true);
        assertPageId(id);
        const page = await this.store.read(id);
        if (page === undefined)
            return { index, op: 'update', id, status: 'error', detail: `no wiki page "${id}"` };
        const body = op.body !== undefined ? textValue(op.body, 'body', false) : undefined;
        if (op.body !== undefined && body === undefined)
            throw new Error('body must be a string');
        if (body !== undefined)
            this.checkBodySize(id, body);
        const title = op.title !== undefined ? textValue(op.title, 'title', false) : undefined;
        const addedLinks = op.links !== undefined ? parseLinkEntries(op.links, id) : [];
        const refused = this.checkTargets(id, unionLinks(page.links, addedLinks), scope);
        if (refused !== undefined) {
            this.log(entries, op, [id], 'rejected', refused);
            return { index, op: 'update', id, status: 'rejected', detail: refused };
        }
        const updated = {
            ...page,
            title: title ?? page.title,
            body: body !== undefined ? body.trimEnd() + '\n' : page.body,
            status: op.status ?? page.status,
            tags: op.tags !== undefined ? unionList(page.tags, op.tags) : page.tags,
            links: op.links !== undefined ? unionLinks(page.links, addedLinks) : page.links,
            sources: op.sources !== undefined ? unionList(page.sources, op.sources.map((s) => (assertPageId(s), s))) : page.sources,
            revision: page.revision + 1,
            updated: nowIso(),
        };
        if (updated.title === page.title &&
            updated.body === page.body &&
            updated.status === page.status &&
            updated.tags.length === page.tags.length &&
            updated.links.length === page.links.length &&
            updated.sources.length === page.sources.length) {
            return { index, op: 'update', id, status: 'noop', detail: 'no field changed' };
        }
        await this.store.writePage(updated);
        this.log(entries, op, [id], 'applied', `revision ${page.revision} -> ${updated.revision}`);
        return { index, op: 'update', id, status: 'applied', detail: `revision ${page.revision} -> ${updated.revision}` };
    }
    async merge(op, index, entries) {
        const fromId = textValue(op.id, 'id (source page to merge away)', true);
        const intoId = textValue(op.into_id, 'into_id', true);
        assertPageId(fromId);
        assertPageId(intoId);
        if (fromId === intoId)
            return { index, op: 'merge', id: fromId, status: 'error', detail: 'cannot merge a page into itself' };
        const from = await this.store.read(fromId);
        if (from === undefined)
            return { index, op: 'merge', id: fromId, status: 'error', detail: `no wiki page "${fromId}"` };
        const into = await this.store.read(intoId);
        if (into === undefined)
            return { index, op: 'merge', id: intoId, status: 'error', detail: `no wiki page "${intoId}"` };
        if (from.status === 'merged' && from.supersededBy === intoId) {
            return { index, op: 'merge', id: fromId, status: 'noop', detail: `already merged into ${intoId}` };
        }
        const note = op.note !== undefined ? `\n\n_Merge note: ${op.note}_` : '';
        const mergedFrom = {
            ...from,
            status: 'merged',
            supersededBy: intoId,
            body: `> Merged into **[[${intoId}]] (${into.title})**.${note}\n`,
            revision: from.revision + 1,
            updated: nowIso(),
        };
        const mergedInto = {
            ...into,
            links: unionLinks(into.links, [{ target: fromId }]),
            tags: unionList(into.tags, from.tags),
            sources: unionList(into.sources, from.sources),
            revision: into.revision + 1,
            updated: nowIso(),
        };
        await this.store.writePage(mergedFrom);
        await this.store.writePage(mergedInto);
        this.log(entries, op, [fromId, intoId], 'applied', `merged ${fromId} -> ${intoId}`);
        return { index, op: 'merge', id: fromId, status: 'applied', detail: `"${fromId}" is now a redirect stub into "${intoId}"; the duplicate title stays for history` };
    }
    async link(op, index, entries) {
        const fromId = textValue(op.id, 'id (source page of the relation)', true);
        const toId = textValue(op.to_id, 'to_id', true);
        assertPageId(fromId);
        assertPageId(toId);
        if (fromId === toId)
            return { index, op: 'link', id: fromId, status: 'error', detail: 'cannot link a page to itself' };
        const from = await this.store.read(fromId);
        if (from === undefined)
            return { index, op: 'link', id: fromId, status: 'error', detail: `no wiki page "${fromId}"` };
        const to = await this.store.read(toId);
        if (to === undefined)
            return { index, op: 'link', id: toId, status: 'error', detail: `no wiki page "${toId}"` };
        const added = parseLinkEntries(op.relation !== undefined ? [`${toId} | ${op.relation}`] : [toId], fromId);
        const links = unionLinks(from.links, added);
        if (links.length === from.links.length)
            return { index, op: 'link', id: fromId, status: 'noop', detail: `link to "${toId}" already present` };
        await this.store.writePage({ ...from, links, revision: from.revision + 1, updated: nowIso() });
        this.log(entries, op, [fromId, toId], 'applied', `linked ${fromId} -> ${toId}`);
        return { index, op: 'link', id: fromId, status: 'applied', detail: `${fromId} -> ${toId}${op.relation !== undefined ? ` (${op.relation})` : ''}` };
    }
    async deprecate(op, index, entries) {
        const id = textValue(op.id, 'id', true);
        assertPageId(id);
        const page = await this.store.read(id);
        if (page === undefined)
            return { index, op: 'deprecate', id, status: 'error', detail: `no wiki page "${id}"` };
        if (page.status === 'deprecated' && (op.superseded_by === undefined || page.supersededBy === op.superseded_by)) {
            return { index, op: 'deprecate', id, status: 'noop', detail: 'already deprecated' };
        }
        if (op.superseded_by !== undefined) {
            assertPageId(op.superseded_by);
            const replacement = await this.store.read(op.superseded_by);
            if (replacement === undefined)
                return { index, op: 'deprecate', id, status: 'error', detail: `superseded_by "${op.superseded_by}" does not exist` };
        }
        const reason = op.reason ?? op.note ?? 'superseded by newer knowledge';
        const deprecated = {
            ...page,
            status: 'deprecated',
            supersededBy: op.superseded_by,
            body: `> **Deprecated**: ${reason}${op.superseded_by !== undefined ? ` (see [[${op.superseded_by}]])` : ''}\n\n${page.body}`,
            revision: page.revision + 1,
            updated: nowIso(),
        };
        await this.store.writePage(deprecated);
        this.log(entries, op, [id], 'applied', reason);
        return { index, op: 'deprecate', id, status: 'applied', detail: `deprecated (revision ${deprecated.revision}); page kept for history, excluded from default search` };
    }
}
/** Every page id a result touches, so the feedback covers both sides of a merge. */
function resultPages(op, result) {
    const ids = [result.id];
    if (op.op === 'merge' && op.into_id !== undefined)
        ids.push(op.into_id);
    if (op.op === 'link' && op.to_id !== undefined)
        ids.push(op.to_id);
    if (op.op === 'deprecate' && op.superseded_by !== undefined)
        ids.push(op.superseded_by);
    return ids;
}
/**
 * One-line human summary of graph feedback, for tool results and journals.
 * Deterministic and short: the numbers first, the advice only when there is a
 * hole worth naming.
 */
export function describeGraph(feedback) {
    const stats = feedback.stats;
    const head = `graph: ${stats.edges} edge(s) (${stats.byKind.link} link${stats.byKind.wikilink > 0 ? `, ${stats.byKind.wikilink} [[id]]` : ''}${stats.byKind.source > 0 ? `, ${stats.byKind.source} source` : ''}), ${stats.dangling} dangling, ${stats.orphans}/${stats.pages} orphan(s)`;
    const advice = feedback.notes.slice(0, 3);
    const suggestions = feedback.suggestions.reduce((sum, entry) => sum + entry.candidates.length, 0);
    const parts = [head];
    if (suggestions > 0)
        parts.push(`${suggestions} candidate link(s) nominated — verify them with wiki_inspect and add the ones that hold with op "link"`);
    if (advice.length > 0)
        parts.push(advice.join('; '));
    return parts.join(' — ');
}
//# sourceMappingURL=mutator.js.map