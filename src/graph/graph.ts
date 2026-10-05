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

export const ALL_EDGE_KINDS: readonly GraphEdgeKind[] = ['link', 'wikilink', 'source'];

/** Edges that say "this page is connected to knowledge", i.e. not provenance. */
export const KNOWLEDGE_EDGE_KINDS: readonly GraphEdgeKind[] = ['link', 'wikilink'];

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
 * `[[page-id]]` mention grammar. An optional `|alias` tail is accepted and
 * ignored (Wikipedia alias syntax), and the id must satisfy the page-id grammar
 * so a `[[TODO]]` or `[[中文标题]]` is prose, not an edge.
 */
const WIKI_LINK_SOURCE = String.raw`\[\[\s*([a-z0-9][a-z0-9._-]{0,79})\s*(?:\|([^\]\n]*))?\]\]`;

/**
 * Mentions of other pages in body text, in first-seen order, self-mentions
 * excluded. Code is not a mention: `[[id]]` inside a fenced block or an inline
 * span is an example about the syntax, not a claim that the pages relate.
 */
export function extractWikiLinks(text: string, selfId?: string): string[] {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  // A fresh scanner per call: a shared `g`-flag regex carries `lastIndex`
  // between callers, which is how a renderer once looped forever (Appendix B of
  // docs/proposal-graph-maintenance.md). Derivation is pure, so it must not share state.
  const scanner = new RegExp(WIKI_LINK_SOURCE, 'g');
  const out: string[] = [];
  const seen = new Set<string>();
  for (let match = scanner.exec(prose); match !== null; match = scanner.exec(prose)) {
    const target = match[1];
    if (target === undefined || target === selfId || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/** Structural graph over one immutable page set. */
export class WikiGraph {
  readonly pages: readonly WikiPage[];
  readonly options: GraphOptions;
  private readonly byId = new Map<string, WikiPage>();
  private readonly out = new Map<string, GraphEdge[]>();
  private readonly in = new Map<string, GraphEdge[]>();
  private edgeCount = 0;
  private dangling: DanglingEdge[] = [];

  private constructor(pages: readonly WikiPage[], options: GraphOptions) {
    this.pages = pages;
    this.options = options;
    for (const page of pages) {
      // Ids are unique by construction; a duplicate (hand-edited tree) keeps the
      // first file so the graph stays deterministic.
      if (!this.byId.has(page.id)) this.byId.set(page.id, page);
    }
    this.build();
  }

  static fromPages(pages: readonly WikiPage[], options: GraphOptions): WikiGraph {
    return new WikiGraph(pages, options);
  }

  private add(edge: GraphEdge): void {
    this.edgeCount++;
    const outgoing = this.out.get(edge.from);
    if (outgoing === undefined) this.out.set(edge.from, [edge]);
    else outgoing.push(edge);
    const incoming = this.in.get(edge.to);
    if (incoming === undefined) this.in.set(edge.to, [edge]);
    else incoming.push(edge);
  }

  private build(): void {
    const { wikiLinkEdges, sourceEdges } = this.options;
    for (const page of this.byId.values()) {
      const declared = new Set<string>();
      for (const link of page.links) {
        if (link.target === page.id) continue;
        declared.add(link.target);
        const edge: GraphEdge = { from: page.id, to: link.target, kind: 'link' };
        if (link.relation !== undefined && link.relation.length > 0) edge.relation = link.relation;
        this.add(edge);
      }
      if (wikiLinkEdges) {
        for (const target of extractWikiLinks(page.body, page.id)) {
          if (declared.has(target)) continue; // the declared edge already says it
          this.add({ from: page.id, to: target, kind: 'wikilink' });
        }
      }
      if (sourceEdges) {
        for (const target of page.sources) {
          if (target === page.id) continue;
          this.add({ from: page.id, to: target, kind: 'source' });
        }
      }
    }
    // A declared edge to nothing is a defect worth naming; a `[[mention]]` of a
    // page that does not exist yet is only a hole the same page can still fill.
    for (const edge of this.allEdges()) {
      if (edge.kind === 'source') continue;
      if (!this.byId.has(edge.to)) {
        const dangling: DanglingEdge = { page: edge.from, target: edge.to, kind: edge.kind };
        if (edge.relation !== undefined) dangling.relation = edge.relation;
        this.dangling.push(dangling);
      }
    }
  }

  /** Every edge, in page order. */
  *allEdges(): Generator<GraphEdge> {
    for (const id of this.byId.keys()) for (const edge of this.out.get(id) ?? []) yield edge;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): WikiPage | undefined {
    return this.byId.get(id);
  }

  /** Declared frontmatter links (the only edges a page can *own*). */
  declared(id: string): readonly WikiLink[] {
    return this.byId.get(id)?.links ?? [];
  }

  outgoing(id: string, kinds: readonly GraphEdgeKind[] = ALL_EDGE_KINDS): GraphEdge[] {
    return (this.out.get(id) ?? []).filter((edge) => kinds.includes(edge.kind));
  }

  incoming(id: string, kinds: readonly GraphEdgeKind[] = ALL_EDGE_KINDS): GraphEdge[] {
    return (this.in.get(id) ?? []).filter((edge) => kinds.includes(edge.kind));
  }

  /** Pages citing a source card, i.e. the provenance consumers of that card. */
  referencedBy(id: string): string[] {
    return this.incoming(id, ['source']).map((edge) => edge.from).sort();
  }

  /** Ids reachable in one hop over knowledge edges, with the strongest label. */
  neighbors(id: string): { id: string; direction: 'out' | 'in'; relation?: string; kind: GraphEdgeKind }[] {
    const seen = new Map<string, { id: string; direction: 'out' | 'in'; relation?: string; kind: GraphEdgeKind }>();
    for (const edge of this.outgoing(id, KNOWLEDGE_EDGE_KINDS)) {
      if (!this.byId.has(edge.to)) continue;
      const entry: { id: string; direction: 'out' | 'in'; relation?: string; kind: GraphEdgeKind } = { id: edge.to, direction: 'out', kind: edge.kind };
      if (edge.relation !== undefined) entry.relation = edge.relation;
      if (!seen.has(edge.to)) seen.set(edge.to, entry);
    }
    for (const edge of this.incoming(id, KNOWLEDGE_EDGE_KINDS)) {
      if (!this.byId.has(edge.from) || seen.has(edge.from)) continue;
      const entry: { id: string; direction: 'out' | 'in'; relation?: string; kind: GraphEdgeKind } = { id: edge.from, direction: 'in', kind: edge.kind };
      if (edge.relation !== undefined) entry.relation = edge.relation;
      seen.set(edge.from, entry);
    }
    return [...seen.values()];
  }

  danglingEdges(): DanglingEdge[] {
    return [...this.dangling];
  }

  danglingOf(id: string): DanglingEdge[] {
    return this.dangling.filter((edge) => edge.page === id);
  }

  /** Knowledge edges leaving a page (provenance refs excluded on purpose). */
  knowledgeOutbound(id: string): number {
    return this.outgoing(id, KNOWLEDGE_EDGE_KINDS).length;
  }

  /** Knowledge edges arriving at a page. */
  knowledgeInbound(id: string): number {
    return this.incoming(id, KNOWLEDGE_EDGE_KINDS).length;
  }

  /** Pages the given set points at that the set itself does not contain. */
  missingTargets(ids: Iterable<string>): string[] {
    const missing = new Set<string>();
    for (const id of ids) {
      for (const edge of this.outgoing(id, ['link', 'wikilink'])) {
        if (!this.byId.has(edge.to)) missing.add(edge.to);
      }
    }
    return [...missing].sort();
  }

  stats(): GraphStats {
    const byKind: Record<GraphEdgeKind, number> = { link: 0, wikilink: 0, source: 0 };
    for (const edge of this.allEdges()) byKind[edge.kind]++;
    const active = this.pages.filter((page) => page.kind !== 'source' && page.status === 'active');
    let orphans = 0;
    let isolated = 0;
    for (const page of active) {
      if (this.knowledgeInbound(page.id) === 0) orphans++;
      if (this.knowledgeOutbound(page.id) === 0) isolated++;
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

/** One page's worth of graph shape, as reported by tools and routes. */
export interface GraphView {
  pages: number;
  edges: number;
  dangling: number;
  orphans: number;
}

/** Compact, wire-friendly summary of {@link WikiGraph.stats}. */
export function graphView(graph: WikiGraph): GraphView {
  const stats = graph.stats();
  return { pages: stats.pages, edges: stats.edges, dangling: stats.dangling, orphans: stats.orphans };
}

/** Page kinds whose edges count toward wiki-layer connectivity. */
export const WIKI_LAYER_KINDS: readonly PageKind[] = ['concept', 'entity'];
