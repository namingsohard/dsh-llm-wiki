import { queryTokens, scorePage } from '../retrieval/grep-retriever.js';
import { KNOWLEDGE_EDGE_KINDS } from './graph.js';
/**
 * Neighbor Suggestion: the write path's edge *nomination*. When a page is
 * created or updated, the same deterministic scorer that answers `wiki_search`
 * is turned on the corpus with the page's own text as the query, and the top
 * matches come back as *candidate* links.
 *
 * Nomination is the whole design. An auto-written edge is a claim nobody made:
 * it would fabricate relations, and it would silently disarm the very checks
 * that keep the graph honest (an auto-linked page is no longer an orphan, so
 * the metric that reveals an unconnected page would go green on its own). So
 * this module only ever returns text for an agent or human to judge; nothing
 * writes a `links:` entry it was not asked to.
 *
 * @module dsh-llm-wiki/graph/suggest
 */
/** Body characters fed into the scorer; a page's tail rarely changes the verdict. */
const QUERY_BODY_CHARS = 4000;
/** Query tokens per page: bounds the O(pages × tokens) scan on a large wiki. */
const MAX_QUERY_TOKENS = 48;
/** How many shared terms to quote as the evidence for a suggestion. */
const MAX_SHARED_TERMS = 5;
/**
 * Terms worth quoting. The scorer is shared with `wiki_search`, and it does give a
 * lone `s` or `120` a little weight when it recurs; as *evidence shown to a human*
 * such a term says nothing, so it is dropped here. A single CJK character is kept —
 * there, one glyph is a word.
 */
function quotable(token) {
    return !/^[a-z0-9]$/.test(token);
}
function sharedTerms(candidate, tokens) {
    const titleLower = candidate.title.toLowerCase();
    const tagLower = candidate.tags.map((tag) => tag.toLowerCase());
    const bodyLower = candidate.body.toLowerCase();
    const strong = [];
    const weak = [];
    for (const token of tokens) {
        if (!quotable(token))
            continue;
        if (titleLower.includes(token) || tagLower.some((tag) => tag.includes(token))) {
            if (!strong.includes(token))
                strong.push(token);
        }
        else if (bodyLower.includes(token) && !weak.includes(token)) {
            weak.push(token);
        }
    }
    return [...strong, ...weak].slice(0, MAX_SHARED_TERMS);
}
/**
 * Rank pages that could plausibly link to or from `subject`.
 *
 * Excluded by construction: the subject itself, source cards (provenance is a
 * different edge family), archived pages, and anything the subject already
 * touches in either direction — the point is the missing edge, not the existing one.
 */
export function suggestNeighbors(graph, subject, options) {
    const query = `${subject.title}\n${subject.tags.join(' ')}\n${subject.body.slice(0, QUERY_BODY_CHARS)}`;
    const tokens = queryTokens(query).slice(0, MAX_QUERY_TOKENS);
    if (tokens.length === 0)
        return [];
    const connected = new Set([subject.id]);
    for (const edge of graph.outgoing(subject.id, KNOWLEDGE_EDGE_KINDS))
        connected.add(edge.to);
    for (const edge of graph.incoming(subject.id, KNOWLEDGE_EDGE_KINDS))
        connected.add(edge.from);
    const out = [];
    for (const candidate of graph.pages) {
        if (candidate.kind === 'source')
            continue;
        if (candidate.status !== 'active')
            continue;
        if (connected.has(candidate.id))
            continue;
        const scored = scorePage(candidate, query, tokens, options.agingAfterDays, options.staleAfterDays);
        if (scored === undefined || scored.score < options.minScore)
            continue;
        out.push({ id: candidate.id, title: candidate.title, kind: candidate.kind, score: scored.score, shared: sharedTerms(candidate, tokens) });
    }
    out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return out.slice(0, Math.max(0, options.limit));
}
//# sourceMappingURL=suggest.js.map