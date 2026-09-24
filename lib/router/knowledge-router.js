/**
 * Knowledge Router: the decision layer that coordinates Wiki Retrieval with
 * external acquisition (DSH Web Search). It scores how well the wiki covers a
 * query and advises wiki-first reuse versus a web round-trip. The router is
 * deterministic and advisory; the agent remains the final authority, per the
 * blueprint's "Wiki 覆盖程度 / 知识新鲜度 / 当前任务需求" criteria.
 *
 * @module dsh-llm-wiki/router/knowledge-router
 */
/**
 * Terms that make a query time-sensitive — a stale wiki is not enough.
 *
 * ASCII and CJK are matched separately on purpose. JS `\b` treats only
 * `[A-Za-z0-9_]` as word characters, so a Han character is a non-boundary on
 * both sides: `\b最新\b` can never match inside natural Chinese (only when the
 * term is flanked by ASCII alphanumerics). CJK terms therefore go unanchored.
 */
const TIME_SENSITIVE_ASCII = /\b(20\d{2}|latest|current|recent|recently|today|yesterday|now|this\s+(?:week|month|year))\b/i;
const TIME_SENSITIVE_CJK = /最新|最近|当前|今年|本月|本周|昨天|今天/;
/** True when a query asks for something time-sensitive (any language). */
export function isTimeSensitive(query) {
    return TIME_SENSITIVE_ASCII.test(query) || TIME_SENSITIVE_CJK.test(query);
}
/**
 * Coverage buckets, from the raw score and — since a loud match on one
 * incidental term is not coverage — from how much of the query the page
 * actually answered. A page about Earth used to read as "partial" coverage for
 * a question about maps: one shared word in the title scored 4, which was the
 * whole bar. The ratio and `strong` floors below are what keep that in `low`.
 */
const HIGH_MIN_SCORE = 8;
const PARTIAL_MIN_SCORE = 3;
/** Anything below this is not a hit worth a bucket. */
const ANY_MIN_SCORE = 1;
/** Fraction of the query's weighted terms the page must answer to be `high`. */
const HIGH_MIN_RATIO = 0.6;
/** Fraction that is enough to call it partial coverage rather than background. */
const PARTIAL_MIN_RATIO = 0.34;
/** At least one specific term in the title/tags, for `high`. */
const HIGH_MIN_STRONG = 1;
/** Map raw top score (plus its coverage evidence) to a coverage bucket. */
export function coverageFromScore(topScore, match) {
    if (topScore === undefined || topScore < ANY_MIN_SCORE)
        return 'none';
    const byScore = topScore >= HIGH_MIN_SCORE ? 'high' : topScore >= PARTIAL_MIN_SCORE ? 'partial' : 'low';
    // Synthesised hits carry no match stats: fall back to the score alone.
    if (match === undefined || match.total <= 0)
        return byScore;
    const ratio = match.matched / match.total;
    if (byScore === 'high' && ratio >= HIGH_MIN_RATIO && match.strong >= HIGH_MIN_STRONG)
        return 'high';
    if (topScore >= PARTIAL_MIN_SCORE && ratio >= PARTIAL_MIN_RATIO)
        return 'partial';
    return 'low';
}
function downgrade(coverage) {
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
/** Compact, honest rendering of the match stats, for the model to judge with. */
function matchNote(match) {
    if (match === undefined || match.total <= 0)
        return '';
    const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
    const strong = match.strong >= 1
        ? `, ${num(match.strong)} of them in its title or tags`
        : ', none of them a specific term in its title or tags';
    return ` (matched ${num(match.matched)}/${num(match.total)} of your query terms${strong})`;
}
/**
 * Decide how to answer a query given retrieval results.
 * @param hits - ranked hits from {@link grep-retriever} (may be empty).
 * @param query - the original query (used for time-sensitivity detection).
 */
export function routeQuery(hits, query) {
    const top = hits[0];
    let coverage = coverageFromScore(top?.score, top?.match);
    const topIsStale = top !== undefined && top.freshness === 'stale';
    if (topIsStale)
        coverage = downgrade(coverage);
    const timeSensitive = isTimeSensitive(query);
    if (timeSensitive && coverage === 'high')
        coverage = 'partial';
    const useWiki = coverage === 'high' || coverage === 'partial';
    // Only a `high` verdict means the wiki can answer on its own; `partial` means
    // part of the answer is still out there, even when the page is worth reading.
    const needWeb = coverage !== 'high';
    let advice;
    let nextStep;
    let guideTopic;
    if (coverage === 'high') {
        const id = top?.id ?? '';
        advice = `Wiki covers this well (top hit "${id}", score ${top?.score ?? 0}). Reuse it: wiki_inspect the page and cite its sources. No web search needed.`;
        nextStep = `wiki_inspect({ id: "${id}" }) — answer from that page and cite its sources; skip the web.`;
        guideTopic = 'router';
    }
    else if (coverage === 'partial') {
        const id = top?.id ?? '';
        // Deliberately not an instruction to read the page: the router cannot tell
        // "same subject, thinner" from "shares a word". The agent can, so it gets
        // the evidence and both branches, not an order.
        advice = `Top hit "${id}"${matchNote(top?.match)} may be your subject or merely share a word with it — you know the question, the score does not, so judge it from its title and snippet. Same subject: read it, fetch only what is missing, merge it back with wiki_mutate (UPDATE / LINK). Different subject: skip it, get the substance from the web, and CREATE its own page rather than folding it into "${id}".`;
        if (timeSensitive)
            advice += ' The query looks time-sensitive — verify freshness against a current source.';
        nextStep = timeSensitive
            ? `Judge "${id}" against the question first: yours → wiki_inspect it, then web_search the current state and wiki_mutate op "update" on it; not yours → web_search and wiki_mutate op "create".`
            : `Judge "${id}" against the question first: yours → wiki_inspect it, web_search only the gap, then wiki_mutate op "update" (or "link"); not yours → web_search and wiki_mutate op "create" a separate page.`;
        guideTopic = 'mutation';
    }
    else if (coverage === 'low') {
        advice = `Wiki has only weakly-related pages: top hit "${top?.id ?? ''}"${matchNote(top?.match)}. Treat them as background, not as an answer; run a web search for the substance, then record its link and create wiki pages.`;
        nextStep = timeSensitive
            ? 'web_search the current state, then wiki_source_save the URL, then wiki_mutate create with admission scores — and re-verify before you rely on the weakly-related pages.'
            : 'web_search for the substance, then wiki_source_save the URL you used and wiki_mutate create with admission scores (the page body carries the substance; the card stores only the link).';
        guideTopic = 'extraction';
    }
    else {
        advice = 'Wiki has no relevant knowledge yet. Acquire via web search / document reading, then persist: wiki_source_save (the link) followed by wiki_mutate (CREATE with admission scores).';
        nextStep = 'web_search this query, then wiki_source_save the URL you actually used, then wiki_mutate create with admission scores.';
        guideTopic = 'extraction';
    }
    const decision = { coverage, useWiki, needWeb, advice, nextStep, guideTopic };
    if (top !== undefined)
        decision.topHit = top;
    return decision;
}
//# sourceMappingURL=knowledge-router.js.map