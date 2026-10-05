export const ALL_EDGE_KINDS = ['link', 'wikilink', 'source'];
/** Edges that say "this page is connected to knowledge", i.e. not provenance. */
export const KNOWLEDGE_EDGE_KINDS = ['link', 'wikilink'];
/**
 * `[[page-id]]` mention grammar. An optional `|alias` tail is accepted and
 * ignored (Wikipedia alias syntax), and the id must satisfy the page-id grammar
 * so a `[[TODO]]` or `[[中文标题]]` is prose, not an edge.
 */
const WIKI_LINK_SOURCE = String.raw `\[\[\s*([a-z0-9][a-z0-9._-]{0,79})\s*(?:\|([^\]\n]*))?\]\]`;
/**
 * Mentions of other pages in body text, in first-seen order, self-mentions
 * excluded. Code is not a mention: `[[id]]` inside a fenced block or an inline
 * span is an example about the syntax, not a claim that the pages relate.
 */
export function extractWikiLinks(text, selfId) {
    const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
    // A fresh scanner per call: a shared `g`-flag regex carries `lastIndex`
    // between callers, which is how a renderer once looped forever (Appendix B of
    // docs/proposal-graph-maintenance.md). Derivation is pure, so it must not share state.
    const scanner = new RegExp(WIKI_LINK_SOURCE, 'g');
    const out = [];
    const seen = new Set();
    for (let match = scanner.exec(prose); match !== null; match = scanner.exec(prose)) {
        const target = match[1];
        if (target === undefined || target === selfId || seen.has(target))
            continue;
        seen.add(target);
        out.push(target);
    }
    return out;
}
/** Structural graph over one immutable page set. */
export class WikiGraph {
    pages;
    options;
    byId = new Map();
    out = new Map();
    in = new Map();
    edgeCount = 0;
    dangling = [];
    constructor(pages, options) {
        this.pages = pages;
        this.options = options;
        for (const page of pages) {
            // Ids are unique by construction; a duplicate (hand-edited tree) keeps the
            // first file so the graph stays deterministic.
            if (!this.byId.has(page.id))
                this.byId.set(page.id, page);
        }
        this.build();
    }
    static fromPages(pages, options) {
        return new WikiGraph(pages, options);
    }
    add(edge) {
        this.edgeCount++;
        const outgoing = this.out.get(edge.from);
        if (outgoing === undefined)
            this.out.set(edge.from, [edge]);
        else
            outgoing.push(edge);
        const incoming = this.in.get(edge.to);
        if (incoming === undefined)
            this.in.set(edge.to, [edge]);
        else
            incoming.push(edge);
    }
    build() {
        const { wikiLinkEdges, sourceEdges } = this.options;
        for (const page of this.byId.values()) {
            const declared = new Set();
            for (const link of page.links) {
                if (link.target === page.id)
                    continue;
                declared.add(link.target);
                const edge = { from: page.id, to: link.target, kind: 'link' };
                if (link.relation !== undefined && link.relation.length > 0)
                    edge.relation = link.relation;
                this.add(edge);
            }
            if (wikiLinkEdges) {
                for (const target of extractWikiLinks(page.body, page.id)) {
                    if (declared.has(target))
                        continue; // the declared edge already says it
                    this.add({ from: page.id, to: target, kind: 'wikilink' });
                }
            }
            if (sourceEdges) {
                for (const target of page.sources) {
                    if (target === page.id)
                        continue;
                    this.add({ from: page.id, to: target, kind: 'source' });
                }
            }
        }
        // A declared edge to nothing is a defect worth naming; a `[[mention]]` of a
        // page that does not exist yet is only a hole the same page can still fill.
        for (const edge of this.allEdges()) {
            if (edge.kind === 'source')
                continue;
            if (!this.byId.has(edge.to)) {
                const dangling = { page: edge.from, target: edge.to, kind: edge.kind };
                if (edge.relation !== undefined)
                    dangling.relation = edge.relation;
                this.dangling.push(dangling);
            }
        }
    }
    /** Every edge, in page order. */
    *allEdges() {
        for (const id of this.byId.keys())
            for (const edge of this.out.get(id) ?? [])
                yield edge;
    }
    has(id) {
        return this.byId.has(id);
    }
    get(id) {
        return this.byId.get(id);
    }
    /** Declared frontmatter links (the only edges a page can *own*). */
    declared(id) {
        return this.byId.get(id)?.links ?? [];
    }
    outgoing(id, kinds = ALL_EDGE_KINDS) {
        return (this.out.get(id) ?? []).filter((edge) => kinds.includes(edge.kind));
    }
    incoming(id, kinds = ALL_EDGE_KINDS) {
        return (this.in.get(id) ?? []).filter((edge) => kinds.includes(edge.kind));
    }
    /** Pages citing a source card, i.e. the provenance consumers of that card. */
    referencedBy(id) {
        return this.incoming(id, ['source']).map((edge) => edge.from).sort();
    }
    /** Ids reachable in one hop over knowledge edges, with the strongest label. */
    neighbors(id) {
        const seen = new Map();
        for (const edge of this.outgoing(id, KNOWLEDGE_EDGE_KINDS)) {
            if (!this.byId.has(edge.to))
                continue;
            const entry = { id: edge.to, direction: 'out', kind: edge.kind };
            if (edge.relation !== undefined)
                entry.relation = edge.relation;
            if (!seen.has(edge.to))
                seen.set(edge.to, entry);
        }
        for (const edge of this.incoming(id, KNOWLEDGE_EDGE_KINDS)) {
            if (!this.byId.has(edge.from) || seen.has(edge.from))
                continue;
            const entry = { id: edge.from, direction: 'in', kind: edge.kind };
            if (edge.relation !== undefined)
                entry.relation = edge.relation;
            seen.set(edge.from, entry);
        }
        return [...seen.values()];
    }
    danglingEdges() {
        return [...this.dangling];
    }
    danglingOf(id) {
        return this.dangling.filter((edge) => edge.page === id);
    }
    /** Knowledge edges leaving a page (provenance refs excluded on purpose). */
    knowledgeOutbound(id) {
        return this.outgoing(id, KNOWLEDGE_EDGE_KINDS).length;
    }
    /** Knowledge edges arriving at a page. */
    knowledgeInbound(id) {
        return this.incoming(id, KNOWLEDGE_EDGE_KINDS).length;
    }
    /** Pages the given set points at that the set itself does not contain. */
    missingTargets(ids) {
        const missing = new Set();
        for (const id of ids) {
            for (const edge of this.outgoing(id, ['link', 'wikilink'])) {
                if (!this.byId.has(edge.to))
                    missing.add(edge.to);
            }
        }
        return [...missing].sort();
    }
    stats() {
        const byKind = { link: 0, wikilink: 0, source: 0 };
        for (const edge of this.allEdges())
            byKind[edge.kind]++;
        const active = this.pages.filter((page) => page.kind !== 'source' && page.status === 'active');
        let orphans = 0;
        let isolated = 0;
        for (const page of active) {
            if (this.knowledgeInbound(page.id) === 0)
                orphans++;
            if (this.knowledgeOutbound(page.id) === 0)
                isolated++;
        }
        return {
            pages: this.byId.size,
            edges: this.edgeCount,
            byKind,
            dangling: this.dangling.length,
            orphans,
            isolated,
        };
    }
}
/** Compact, wire-friendly summary of {@link WikiGraph.stats}. */
export function graphView(graph) {
    const stats = graph.stats();
    return { pages: stats.pages, edges: stats.edges, dangling: stats.dangling, orphans: stats.orphans };
}
/** Page kinds whose edges count toward wiki-layer connectivity. */
export const WIKI_LAYER_KINDS = ['concept', 'entity'];
//# sourceMappingURL=graph.js.map