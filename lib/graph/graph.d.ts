import type { PageKind, WikiLink, WikiPage } from '../types.js';
/**
 * The Derived Graph: the wiki's link structure, computed from a page set and
 * never stored. Pages stay the single source of truth — an edge is always
 * re-derivable from frontmatter `links:` (and, when enabled, from `[[id]]`
 * mentions and `sources:` refs), so nothing here can drift out of sync and the
 * on-disk format needs no new field.
 *
 * Three edge families, deliberately kept apart:
 * - `link`     declared knowledge edges (`links:` frontmatter, with relation);
 * - `wikilink` edges derived from `[[page-id]]` mentions in a body — written
 *   prose the graph would otherwise not see (`merge` / `deprecate` emit these);
 * - `source`   provenance edges (page → source card, from `sources:`).
 *
 * Every consumer that needs the graph (mutator feedback, linter, HTTP surface,
 * retrieval expansion) builds it from the same pages, so "what is a link" has
 * exactly one answer in this plugin.
 *
 * @module dsh-llm-wiki/graph/graph
 */
/** Which family an edge belongs to. */
export type GraphEdgeKind = 'link' | 'wikilink' | 'source';
export declare const ALL_EDGE_KINDS: readonly GraphEdgeKind[];
/** Edges that say "this page is connected to knowledge", i.e. not provenance. */
export declare const KNOWLEDGE_EDGE_KINDS: readonly GraphEdgeKind[];
/** One directed edge between two page ids. */
export interface GraphEdge {
    from: string;
    to: string;
    kind: GraphEdgeKind;
    /** Relation label; only `link` edges carry one. */
    relation?: string;
}
/** Which optional families count as edges. Derived from plugin config. */
export interface GraphOptions {
    /** Derive edges from `[[page-id]]` mentions in page bodies. */
    wikiLinkEdges: boolean;
    /** Treat `sources:` refs as provenance edges (page → source card). */
    sourceEdges: boolean;
}
/** An edge whose target no page answers. */
export interface DanglingEdge {
    /** Page carrying the edge. */
    page: string;
    /** Missing target id. */
    target: string;
    kind: GraphEdgeKind;
    relation?: string;
}
/** Corpus-level shape of the graph, for reports and metrics. */
export interface GraphStats {
    pages: number;
    edges: number;
    byKind: Record<GraphEdgeKind, number>;
    dangling: number;
    /** Active wiki-layer pages with no inbound knowledge edge. */
    orphans: number;
    /** Active wiki-layer pages with no outbound knowledge edge. */
    isolated: number;
}
/**
 * Mentions of other pages in body text, in first-seen order, self-mentions
 * excluded. Code is not a mention: `[[id]]` inside a fenced block or an inline
 * span is an example about the syntax, not a claim that the pages relate.
 */
export declare function extractWikiLinks(text: string, selfId?: string): string[];
/** Structural graph over one immutable page set. */
export declare class WikiGraph {
    readonly pages: readonly WikiPage[];
    readonly options: GraphOptions;
    private readonly byId;
    private readonly out;
    private readonly in;
    private edgeCount;
    private dangling;
    private constructor();
    static fromPages(pages: readonly WikiPage[], options: GraphOptions): WikiGraph;
    private add;
    private build;
    /** Every edge, in page order. */
    allEdges(): Generator<GraphEdge>;
    has(id: string): boolean;
    get(id: string): WikiPage | undefined;
    /** Declared frontmatter links (the only edges a page can *own*). */
    declared(id: string): readonly WikiLink[];
    outgoing(id: string, kinds?: readonly GraphEdgeKind[]): GraphEdge[];
    incoming(id: string, kinds?: readonly GraphEdgeKind[]): GraphEdge[];
    /** Pages citing a source card, i.e. the provenance consumers of that card. */
    referencedBy(id: string): string[];
    /** Ids reachable in one hop over knowledge edges, with the strongest label. */
    neighbors(id: string): {
        id: string;
        direction: 'out' | 'in';
        relation?: string;
        kind: GraphEdgeKind;
    }[];
    danglingEdges(): DanglingEdge[];
    danglingOf(id: string): DanglingEdge[];
    /** Knowledge edges leaving a page (provenance refs excluded on purpose). */
    knowledgeOutbound(id: string): number;
    /** Knowledge edges arriving at a page. */
    knowledgeInbound(id: string): number;
    /** Pages the given set points at that the set itself does not contain. */
    missingTargets(ids: Iterable<string>): string[];
    stats(): GraphStats;
}
/** One page's worth of graph shape, as reported by tools and routes. */
export interface GraphView {
    pages: number;
    edges: number;
    dangling: number;
    orphans: number;
}
/** Compact, wire-friendly summary of {@link WikiGraph.stats}. */
export declare function graphView(graph: WikiGraph): GraphView;
/** Page kinds whose edges count toward wiki-layer connectivity. */
export declare const WIKI_LAYER_KINDS: readonly PageKind[];
//# sourceMappingURL=graph.d.ts.map