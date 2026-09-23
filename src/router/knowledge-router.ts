import type { Coverage, RouterDecision, SearchHit } from '../types.js';

/**
 * Knowledge Router: the decision layer that coordinates Wiki Retrieval with
 * external acquisition (DSH Web Search). It scores how well the wiki covers a
 * query and advises wiki-first reuse versus a web round-trip. The router is
 * deterministic and advisory; the agent remains the final authority, per the
 * blueprint's "Wiki 覆盖程度 / 知识新鲜度 / 当前任务需求" criteria.
 *
 * @module dsh-llm-wiki/router/knowledge-router
 */

/** Terms that make a query time-sensitive — a stale wiki is not enough. */
const TIME_SENSITIVE = /\b(20\d{2}|latest|current|recent|recently|today|yesterday|now|this\s+(week|month|year)|最新|最近|当前|今年|本月|本周|昨天|今天)\b/i;

/** Map raw top score to a coverage bucket. */
export function coverageFromScore(topScore: number | undefined): Coverage {
  if (topScore === undefined || topScore < 1) return 'none';
  if (topScore >= 8) return 'high';
  if (topScore >= 3) return 'partial';
  return 'low';
}

function downgrade(coverage: Coverage): Coverage {
  switch (coverage) {
    case 'high':
      return 'partial';
    case 'partial':
    case 'low':
      return 'low';
    case 'none':
      return 'none';
  }
}

/**
 * Decide how to answer a query given retrieval results.
 * @param hits - ranked hits from {@link grep-retriever} (may be empty).
 * @param query - the original query (used for time-sensitivity detection).
 */
export function routeQuery(hits: readonly SearchHit[], query: string): RouterDecision {
  const top = hits[0];
  let coverage = coverageFromScore(top?.score);
  const topIsStale = top !== undefined && top.freshness === 'stale';
  if (topIsStale) coverage = downgrade(coverage);

  const timeSensitive = TIME_SENSITIVE.test(query);
  if (timeSensitive && coverage === 'high') coverage = 'partial';

  const useWiki = coverage === 'high' || coverage === 'partial';
  const needWeb = !useWiki || (timeSensitive && coverage !== 'high');

  let advice: string;
  if (coverage === 'high') {
    advice = `Wiki covers this well (top hit "${top?.id ?? ''}", score ${top?.score ?? 0}). Reuse it: wiki_inspect the page and cite its sources. No web search needed.`;
  } else if (coverage === 'partial') {
    advice = `Wiki partially covers this (top hit "${top?.id ?? ''}"). wiki_inspect the page first, then acquire only the missing pieces via web search and merge them back with wiki_mutate (UPDATE/LINK).`;
    if (timeSensitive) advice += ' The query looks time-sensitive — verify freshness against a current source.';
  } else if (coverage === 'low') {
    advice = 'Wiki has only weakly-related pages. Treat them as background; run a web search for the substance, then save the source and create/extend wiki pages.';
  } else {
    advice = 'Wiki has no relevant knowledge yet. Acquire via web search / document reading, then persist: wiki_source_save followed by wiki_mutate (CREATE with admission scores).';
  }

  const decision: RouterDecision = { coverage, useWiki, needWeb, advice };
  if (top !== undefined) decision.topHit = top;
  return decision;
}
