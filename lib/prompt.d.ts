/**
 * System-prompt contribution builder.
 *
 * The section stays deliberately small. It carries only what the model must
 * already know before its first tool call, because everything that only matters
 * once a tool has answered is cheaper and far more persuasive when it travels
 * inside that tool's result (`wiki_search.advice` / `next_step`) or is pulled
 * explicitly through `wiki_guide`. The four playbooks ship as markdown files,
 * read on demand, so a deployment can retune the guidance without rebuilding.
 *
 * @module dsh-llm-wiki/prompt
 */
export type GuideTopic = 'router' | 'extraction' | 'mutation' | 'validation';
/** Playbook files, in guide order. The file stem is the `wiki_guide` topic. */
export declare const GUIDE_TOPICS: readonly GuideTopic[];
/**
 * Mutable snapshot the tools keep current.
 *
 * It feeds the runtime-context state line and the web-access nudge. The exact
 * numbers reach the model only through those append-only channels — never
 * through the system prompt section, whose text has to stay byte-stable.
 */
export interface WikiPromptStats {
    /** Live (non-staged) page count. */
    pages: number;
    /** Entries waiting in `staging/`. */
    pending: number;
    /** Whether the counts above have been read from disk at least once. */
    ready?: boolean;
    /** Session latch: the wiki has never been bigger than this. */
    maxPages?: number;
    /** Session latch: at some point this session had proposals waiting. */
    pendingSeen?: boolean;
}
/**
 * Fold one observation of the wiki into the session latches.
 *
 * The latches live here rather than in the state provider because the harness
 * decides when the provider runs: several writes inside a single step could
 * otherwise come and go between two evaluations and never be seen.
 */
export declare function observeWiki(stats: WikiPromptStats, pages: number, pending: number): void;
/** Fold an observation that only counted the staging queue. */
export declare function observeStaging(stats: WikiPromptStats, pending: number): void;
/** The always-on core. Sized to a dozen lines; it is re-sent every request. */
export declare const CORE_PROMPT = "# DSH-Wiki \u00B7 Agent Semantic Memory\n\nPersistent file wiki: cross-task memory you can actually reuse next session.\nWiki-first: before web_search / web_fetch on a research, factual, product or\ntechnical question likely to recur, call wiki_search and obey its verdict.\n\n- coverage high \u2192 wiki_inspect the top page, answer from it, cite its sources. No web round-trip.\n- coverage partial \u2192 only you can tell \"same subject, thinner\" from \"shares a word\". Judge the top hit:\n  yours \u2192 inspect it, fill the gap, merge back (UPDATE / LINK). Not yours \u2192 CREATE its own page.\n- coverage low / none \u2192 web search as usual, then persist the gain: wiki_source_save records the\n  link (the wiki stores no page text), wiki_mutate writes what you learned from it (CREATE needs admission scores).\n\nAn `aging` or `stale` top hit must be verified against a current source before you rely on it.\nSay which parts of a fused answer came from the wiki (page ids) and which are new.\nNever delete: deprecate. Full playbooks: wiki_guide(topic = router | extraction | mutation | validation).";
/** Read one playbook; undefined when the shipped file is unreadable. */
export declare function readPlaybook(topic: GuideTopic): Promise<string | undefined>;
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
export declare function createPromptSource(logger?: {
    warn?: (message: string, ...args: unknown[]) => void;
}, stats?: WikiPromptStats): {
    provider: (wikiRootDisplay: string, options?: {
        include?: 'core' | 'full';
    }) => string;
    stateProvider: () => string;
    prefetch: () => Promise<void>;
    stats: WikiPromptStats;
};
//# sourceMappingURL=prompt.d.ts.map