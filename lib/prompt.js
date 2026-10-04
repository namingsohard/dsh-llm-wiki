import { readFile } from 'node:fs/promises';
/** Playbook files, in guide order. The file stem is the `wiki_guide` topic. */
export const GUIDE_TOPICS = ['router', 'extraction', 'mutation', 'validation'];
/**
 * Fold one observation of the wiki into the session latches.
 *
 * The latches live here rather than in the state provider because the harness
 * decides when the provider runs: several writes inside a single step could
 * otherwise come and go between two evaluations and never be seen.
 */
export function observeWiki(stats, pages, pending) {
    stats.pages = pages;
    stats.pending = pending;
    if (pages > (stats.maxPages ?? 0))
        stats.maxPages = pages;
    if (pending > 0)
        stats.pendingSeen = true;
    stats.ready = true;
}
/** Fold an observation that only counted the staging queue. */
export function observeStaging(stats, pending) {
    stats.pending = pending;
    if (pending > 0)
        stats.pendingSeen = true;
    stats.ready = true;
}
/**
 * Wiki size in coarse words, never an exact count: creating a page must not
 * re-render the snapshot, so the text only changes when the bucket changes.
 */
function sizePhrase(pages) {
    if (pages <= 0)
        return 'empty — expect coverage none, and prefer one well-admitted page over many thin ones';
    if (pages < 10)
        return 'a handful of pages (under 10) — prefer update / link over create';
    if (pages < 50)
        return 'a working set of pages (10-49) — assume the subject is already covered before reaching for the web';
    return 'a large set of pages (50+) — assume the subject is already covered before reaching for the web';
}
/**
 * The pending half, phrased without a count and latched once set. The exact
 * queue length is a tool-result fact (`pending_total`) that the model can ask
 * for with `wiki_review action: "list"`; what the snapshot owes it is only the
 * reminder that a previous turn may have left something waiting.
 */
const PENDING_NOTE = 'proposals may still sit in staging/ from an earlier turn — nothing is live until the user approves it, and wiki_review action "list" shows what is really there';
/** The always-on core. Sized to a dozen lines; it is re-sent every request. */
export const CORE_PROMPT = `# DSH-Wiki · Agent Semantic Memory

Persistent file wiki: cross-task memory you can actually reuse next session.
Wiki-first: before web_search / web_fetch on a research, factual, product or
technical question likely to recur, call wiki_search and obey its verdict.

- coverage high → wiki_inspect the top page, answer from it, cite its sources. No web round-trip.
- coverage partial → only you can tell "same subject, thinner" from "shares a word". Judge the top hit:
  yours → inspect it, fill the gap, merge back (UPDATE / LINK). Not yours → CREATE its own page.
- coverage low / none → web search as usual, then persist the gain: wiki_source_save records the
  link (the wiki stores no page text), wiki_mutate writes what you learned from it (CREATE needs admission scores).

An \`aging\` or \`stale\` top hit must be verified against a current source before you rely on it.
Say which parts of a fused answer came from the wiki (page ids) and which are new.
Never delete: deprecate. Full playbooks: wiki_guide(topic = router | extraction | mutation | validation).`;
function playbookUrl(name) {
    return new URL(`../prompts/${name}.md`, import.meta.url);
}
/** Read one playbook; undefined when the shipped file is unreadable. */
export async function readPlaybook(topic) {
    try {
        return (await readFile(playbookUrl(topic), 'utf8')).trim();
    }
    catch {
        return undefined;
    }
}
/**
 * Build the prompt contributions.
 *
 * `stats` is a live object, but only the *state provider* reads it. That split
 * is deliberate and it is about provider-side prefix caching: the harness
 * re-assembles the prompt every step and, when the rendered section differs
 * from the previous one, it rewrites the leading system message (or, on
 * `in-history` models, re-sends the whole prompt into the transcript). A single
 * changed digit in a page count therefore invalidates the cached prefix of the
 * entire conversation. Sections stay frozen for the life of the session;
 * volatile state travels in the runtime-context snapshot, which the harness
 * appends to the end of the message list only when its text actually changes —
 * an append costs a sentence, a section rewrite costs the whole history.
 *
 * The two latches in `observeWiki` keep even that append rare: the size bucket
 * only ever ratchets upward and the staging reminder never switches back off.
 */
export function createPromptSource(logger, stats = { pages: 0, pending: 0 }) {
    let warned = false;
    const prefetch = async () => {
        const missing = (await Promise.all(GUIDE_TOPICS.map(async (topic) => ((await readPlaybook(topic)) === undefined ? topic : undefined)))).filter((t) => t !== undefined);
        if (missing.length > 0 && !warned) {
            warned = true;
            logger?.warn?.('dsh-llm-wiki: playbook(s) unavailable %s — wiki_guide will report the gap and the prompt keeps its core text', missing.join(', '));
        }
    };
    void prefetch();
    /** The resident section: identical bytes for the whole session. */
    const provider = (wikiRootDisplay) => [
        CORE_PROMPT,
        '',
        `Wiki root: ${wikiRootDisplay}`,
        'Live wiki state (rough size, staged proposals) rides in the runtime-context snapshot; wiki_review action "list" is authoritative for staging/.',
    ].join('\n');
    /**
     * The volatile half, for `systemPrompt.context()` — coarse by design, and
     * empty until the counts have actually been read, so a wiki with 200 pages
     * is never announced as empty first.
     */
    const stateProvider = () => {
        if (stats.ready !== true)
            return '';
        const pendingNote = stats.pendingSeen === true ? ` ${PENDING_NOTE}` : '';
        return `Wiki state: ${sizePhrase(stats.maxPages ?? stats.pages)}.${pendingNote.length > 0 ? `${pendingNote}.` : ''}`;
    };
    return { provider, stateProvider, prefetch, stats };
}
//# sourceMappingURL=prompt.js.map