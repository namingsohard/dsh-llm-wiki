import { freshnessOf, freshnessWeight } from './freshness.js';
/**
 * Phase-1 retriever: tokenized keyword matching over the Markdown corpus
 * (the blueprint's grep/find/read-file tier, kept dependency-free and
 * explainable). BM25/embedding retrieval can replace this module later
 * without touching tool contracts.
 *
 * Scoring: per query token — title 4, tag 3, body 1, each scaled by the
 * token's specificity; an exact phrase match in title or body adds a bonus.
 * Status and freshness modulate the score; merged pages are never returned.
 *
 * A score alone says how *loudly* a page matched, not how much of the question
 * it answers, so every hit also reports {@link MatchStats}: how many query
 * terms the page matched, and how many of those landed in its title or tags.
 * The Knowledge Router gates its coverage buckets on those numbers.
 *
 * @module dsh-llm-wiki/retrieval/grep-retriever
 */
const ASCII_WORD = /[a-z0-9]+/g;
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;
/** Lowercase word tokens plus CJK unigram+bigram tokens. */
export function tokenize(text) {
    const lower = text.toLowerCase();
    const tokens = [];
    const words = lower.match(ASCII_WORD);
    if (words !== null)
        tokens.push(...words);
    const runs = lower.match(CJK_RUN);
    if (runs !== null) {
        for (const run of runs) {
            for (const char of run)
                tokens.push(char);
            for (let i = 0; i + 1 < run.length; i++)
                tokens.push(run.slice(i, i + 2));
        }
    }
    return tokens;
}
/** Unique tokens preserving first-seen order — query side. */
export function queryTokens(query) {
    const all = [...new Set(tokenize(query))];
    const content = all.filter((token) => !STOPWORDS.has(token));
    // A query of pure function words still has to match on something.
    return content.length > 0 ? content : all;
}
/**
 * English function words. They carry no topic, yet every one of them that a
 * page happens to contain adds to the score and to the coverage denominator —
 * "what is the best way to compact context" would otherwise look half-covered
 * by any page that uses the word "what". CJK needs no list here: a lone Han
 * character is already discounted by {@link tokenWeight}, and the bigram next
 * to it carries the meaning.
 */
const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'cannot', 'could', 'did', 'do',
    'does', 'for', 'from', 'get', 'got', 'had', 'has', 'have', 'he', 'her', 'him', 'his', 'how', 'i', 'if',
    'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'she', 'so',
    'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to',
    'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you',
    'your',
]);
/**
 * How much a single query token is worth. Matching is substring matching, and a
 * one-character token is a substring of a great many unrelated words: 地 is in
 * 地球, 地图, 地理 and 土地 alike, and `g` is in "using" and "config". A Han
 * bigram or a real Latin word is specific enough to count in full. Weights stay
 * in [0, 1], which keeps the score thresholds and the coverage ratio on one scale.
 */
export function tokenWeight(token) {
    return token.length === 1 ? 0.4 : 1;
}
const round2 = (n) => Math.round(n * 100) / 100;
const SNIPPET_RADIUS = 90;
function buildSnippet(page, needle) {
    const body = page.body.replace(/\s+/g, ' ').trim();
    const lower = body.toLowerCase();
    const at = needle.length > 0 ? lower.indexOf(needle.toLowerCase()) : -1;
    if (at < 0)
        return body.slice(0, SNIPPET_RADIUS * 2) + (body.length > SNIPPET_RADIUS * 2 ? '…' : '');
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(body.length, at + needle.length + SNIPPET_RADIUS);
    return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}
/** Score one page against a query; 0 means "not a hit". */
export function scorePage(page, query, qTokens, agingAfterDays, staleAfterDays) {
    if (page.status === 'merged')
        return undefined;
    const freshness = freshnessOf(page, agingAfterDays, staleAfterDays);
    const titleLower = page.title.toLowerCase();
    const tagLower = page.tags.map((tag) => tag.toLowerCase());
    const bodyLower = page.body.toLowerCase();
    const queryLower = query.trim().toLowerCase();
    let score = 0;
    // Weighted term accounting: `matched` is how much of the question this page
    // answers, `strong` how much of that came from the fields an author chooses
    // (title/tags) rather than happened to contain. A page can score loudly on
    // one incidental term; these two numbers are what says otherwise.
    let matched = 0;
    let strong = 0;
    let total = 0;
    let firstBodyToken = '';
    for (const token of qTokens) {
        const weight = tokenWeight(token);
        total += weight;
        if (titleLower.includes(token)) {
            score += 4 * weight;
            matched += weight;
            strong += weight;
        }
        else if (tagLower.some((tag) => tag.includes(token))) {
            score += 3 * weight;
            matched += weight;
            strong += weight;
        }
        else if (bodyLower.includes(token)) {
            score += weight;
            matched += weight;
            if (firstBodyToken.length === 0)
                firstBodyToken = token;
        }
    }
    if (score === 0)
        return undefined;
    // Phrase bonus: a literal query match is strong evidence of coverage.
    let phraseMatched = false;
    if (queryLower.length > 3 && titleLower.includes(queryLower)) {
        score += 6;
        phraseMatched = true;
    }
    else if (queryLower.length > 3 && bodyLower.includes(queryLower)) {
        score += 4;
        phraseMatched = true;
    }
    // The literal phrase is the whole question, matched: it settles the ratio.
    if (phraseMatched) {
        matched = total;
        if (titleLower.includes(queryLower))
            strong = total;
    }
    score *= freshnessWeight(freshness);
    if (page.status === 'deprecated')
        score *= 0.5;
    const needle = queryLower.length > 3 && bodyLower.includes(queryLower) ? queryLower : firstBodyToken;
    return {
        score: round2(score),
        freshness,
        snippet: buildSnippet(page, needle),
        match: { matched: round2(matched), total: round2(total), strong: round2(strong) },
    };
}
/** Corpus cache per store instance, invalidated by `store.version`. */
const corpusCache = new WeakMap();
/** Run a ranked search over the wiki. */
export async function searchWiki(store, options) {
    const kinds = options.kinds ?? ['concept', 'entity'];
    let cached = corpusCache.get(store);
    if (cached === undefined || cached.version !== store.version) {
        cached = (await store.listPages(['concept', 'entity', 'source']));
        corpusCache.set(store, cached);
    }
    const qTokens = queryTokens(options.query);
    if (qTokens.length === 0)
        return { hits: [], scanned: cached.pages.length, failures: cached.failures };
    const hits = [];
    for (const page of cached.pages) {
        if (!kinds.includes(page.kind))
            continue;
        if (!options.includeDeprecated && page.status === 'deprecated')
            continue;
        const scored = scorePage(page, options.query, qTokens, options.agingAfterDays, options.staleAfterDays);
        if (scored === undefined)
            continue;
        hits.push({
            id: page.id,
            kind: page.kind,
            title: page.title,
            status: page.status,
            score: scored.score,
            match: scored.match,
            freshness: scored.freshness,
            snippet: scored.snippet,
            updated: page.updated,
        });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { hits: hits.slice(0, options.limit), scanned: cached.pages.length, failures: cached.failures };
}
//# sourceMappingURL=grep-retriever.js.map