import { freshnessOf } from '../retrieval/freshness.js';
import type { GraphOptions, WikiGraph } from '../graph/graph.js';
import { KNOWLEDGE_EDGE_KINDS } from '../graph/graph.js';
import type { LintIssue, WikiPage } from '../types.js';
import type { WikiConfig } from '../config.js';

/**
 * The deterministic checks, expressed once.
 *
 * `wiki_lint` runs them over the whole corpus; the mutation engine runs the
 * same set over just the pages it touched and folds the findings into the write
 * result. One implementation means a defect cannot be invisible at write time
 * and loud at lint time — the asymmetry that let a dangling edge into the wiki
 * and sit there unnoticed (docs/proposal-graph-maintenance.md, G3).
 *
 * Every check is scoped: a subject set plus the graph it lives in. Nothing here
 * walks the corpus twice or allocates per pair beyond the duplicate scan.
 *
 * @module dsh-llm-wiki/validator/checks
 */

/** How the duplicate check treats a pair. */
export type PairScope =
  /** Corpus mode: report a pair once, attributed to the earlier page. */
  | 'corpus'
  /** Scoped mode: report the pair on the subject, even if the other page came first. */
  | 'subject';

export interface CheckContext {
  graph: WikiGraph;
  config: WikiConfig;
  /** Corpus order, so `corpus` mode reports each pair exactly once. */
  order: ReadonlyMap<string, number>;
  pairScope?: PairScope;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .sort()
    .join(' ');
}

function tokenSet(page: WikiPage): Set<string> {
  return new Set([...page.title.toLowerCase().split(/[^\p{L}\p{N}]+/u), ...page.tags.map((tag) => tag.toLowerCase())].filter((t) => t.length > 0));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Wiki-layer (not provenance) pages in the corpus, in corpus order. */
function wikiLayer(ctx: CheckContext): WikiPage[] {
  return [...ctx.graph.pages].filter((page) => page.kind !== 'source').sort((a, b) => (ctx.order.get(a.id) ?? 0) - (ctx.order.get(b.id) ?? 0));
}

/** Run every check over `subjects` against the whole graph. */
export function runChecks(ctx: CheckContext, subjects: readonly WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const config = ctx.config;

  for (const page of subjects) {
    // Broken links: every declared edge, and every `[[mention]]` when enabled,
    // must resolve. `source` refs are excluded — a card promoted out of order is
    // a staging race, not a graph defect (see `source-missing` in the linter notes).
    for (const edge of ctx.graph.danglingOf(page.id)) {
      if (edge.kind === 'link') {
        issues.push({ check: 'broken-link', level: 'warn', page: page.id, message: `link target "${edge.target}" does not exist${edge.relation !== undefined ? ` (relation: ${edge.relation})` : ''}` });
      } else {
        issues.push({ check: 'broken-link', level: 'warn', page: page.id, message: `body mentions [[${edge.target}]], which does not exist — link it once the page exists or drop the mention` });
      }
    }

    // Deprecated references: active pages pointing at archived knowledge.
    if (page.status === 'active') {
      for (const edge of ctx.graph.outgoing(page.id, KNOWLEDGE_EDGE_KINDS)) {
        const target = ctx.graph.get(edge.to);
        if (target === undefined || target.status === 'active') continue;
        issues.push({ check: 'deprecated-ref', level: 'info', page: page.id, message: `links to ${target.status} page "${target.id}"${target.supersededBy !== undefined ? ` (superseded by ${target.supersededBy})` : ''}` });
      }
    }

    // Duplicates and near-duplicates.
    if (page.kind !== 'source' && page.status === 'active') {
      const here = ctx.order.get(page.id) ?? 0;
      const eachOnce = (ctx.pairScope ?? 'corpus') === 'corpus';
      for (const other of wikiLayer(ctx)) {
        if (other.id === page.id || other.status !== 'active') continue;
        if (eachOnce && (ctx.order.get(other.id) ?? 0) < here) continue;
        if (page.kind !== other.kind) continue;
        if (normalizeTitle(page.title) === normalizeTitle(other.title)) {
          issues.push({ check: 'duplicate', level: 'warn', page: page.id, message: `same normalized title as "${other.id}" ("${other.title}") — consider wiki_mutate merge` });
          continue;
        }
        const similarity = jaccard(tokenSet(page), tokenSet(other));
        if (similarity >= 0.6) {
          issues.push({ check: 'duplicate', level: 'info', page: page.id, message: `highly similar to "${other.id}" (title/tag overlap ${(similarity * 100).toFixed(0)}%) — review for merge` });
        }
      }
    }

    if (page.kind !== 'source' && page.status === 'active') {
      const freshness = freshnessOf(page, config.agingAfterDays, config.staleAfterDays);
      if (freshness === 'stale') {
        issues.push({ check: 'stale', level: 'info', page: page.id, message: `not updated for ${config.staleAfterDays}+ days (last: ${page.updated.slice(0, 10)}) — verify against current sources or deprecate` });
      }
    }

    // Orphans: active wiki-layer pages nothing links to, over knowledge edges.
    if (config.lintOrphans && page.kind !== 'source' && page.status === 'active') {
      if (ctx.graph.knowledgeInbound(page.id) === 0) {
        issues.push({ check: 'orphan', level: 'info', page: page.id, message: 'no inbound links from any page — link it from a related page or it will fade from reuse' });
      }
    }

    // A source card nobody cites is provenance nobody needs.
    if (page.kind === 'source' && page.status === 'active' && ctx.graph.options.sourceEdges) {
      if (ctx.graph.referencedBy(page.id).length === 0) {
        issues.push({ check: 'unreferenced-source', level: 'info', page: page.id, message: `no page lists "${page.id}" in sources — either cite it where it was used or it was saved for nothing` });
      }
    }

    if (page.kind !== 'source' && page.status === 'active') {
      const bytes = Buffer.byteLength(page.body, 'utf8');
      if (bytes > config.maxPageBytes * 0.8) {
        issues.push({ check: 'oversize', level: 'info', page: page.id, message: `body is ${bytes} bytes (${((bytes / config.maxPageBytes) * 100).toFixed(0)}% of cap) — consider splitting into linked pages` });
      }
    }
  }

  return issues;
}

/** Corpus-level convenience: build the order map the checks need. */
export function corpusOrder(pages: readonly WikiPage[]): Map<string, number> {
  return new Map(pages.map((page, index) => [page.id, index]));
}

/** The graph options implied by a resolved configuration. */
export function graphOptionsOf(config: WikiConfig): GraphOptions {
  return { wikiLinkEdges: config.wikiLinkEdges, sourceEdges: config.sourceEdges };
}

/**
 * Scoped variant of the corpus lint: the same checks over one page set. Used by
 * the write path, where a page pair must be reported on the page the agent just
 * touched even if the other page is older — hence `pairScope: 'subject'`.
 */
export function checksFor(graph: WikiGraph, config: WikiConfig, subjects: readonly WikiPage[]): LintIssue[] {
  return runChecks({ graph, config, order: corpusOrder(graph.pages), pairScope: 'subject' }, subjects);
}
