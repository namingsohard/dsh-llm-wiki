import type { LogEntry, PageKind, WikiPage } from '../types.js';
/**
 * Filesystem-backed wiki storage. Layout (root defaults to `~/.dsh/wiki`):
 *
 *   index.md          generated table of contents
 *   concepts/<id>.md  abstract knowledge
 *   entities/<id>.md  concrete objects
 *   sources/<id>.md   raw material (web search results, documents)
 *   logs/<date>.jsonl mutation journal
 *
 * Writes are atomic (temp file + rename) and serialized through an
 * in-process mutex. `version` increments on every successful write so
 * readers can cache listings between mutations.
 *
 * @module dsh-llm-wiki/storage/markdown-store
 */
/** Directory per page kind. */
export declare const KIND_DIRS: Record<PageKind, string>;
/** Minimal logger surface (matches the Cordis ctx.logger shape we use). */
export interface StoreLogger {
    info?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
}
/** A page directory that failed to parse, surfaced as a warning. */
export interface ParseFailure {
    path: string;
    message: string;
}
export declare class WikiStore {
    /** Bumped on every successful mutation; drives reader caches. */
    version: number;
    readonly root: string;
    private readonly logger;
    private chain;
    private initialized;
    constructor(root: string, logger?: StoreLogger | undefined);
    /**
     * Serialize a mutation through the in-process mutex. Rejections never break
     * the chain for later writers.
     */
    withLock<T>(task: () => Promise<T>): Promise<T>;
    /** Create the directory skeleton (idempotent). */
    ensureInit(): Promise<void>;
    /** On-disk location for a page id of the given kind. */
    pagePath(kind: PageKind, id: string): string;
    /** Read one page by id across all kinds. Returns undefined when absent. */
    read(id: string): Promise<WikiPage | undefined>;
    /** Write a page file atomically and bump the store version. */
    writePage(page: WikiPage): Promise<void>;
    /** All page ids currently on disk, keyed by kind. */
    listIds(kinds?: readonly PageKind[]): Promise<Map<string, PageKind>>;
    /**
     * Load every page of the given kinds. Unparseable files are skipped and
     * reported; they never fail the listing.
     */
    listPages(kinds?: readonly PageKind[]): Promise<{
        pages: WikiPage[];
        failures: ParseFailure[];
    }>;
    /** Rebuild `index.md` from the current page set. */
    rebuildIndex(): Promise<void>;
    /** Append entries to today's mutation journal (`logs/YYYY-MM-DD.jsonl`). */
    appendLog(entries: readonly LogEntry[]): Promise<void>;
    /** Recent journal lines, newest last, across the newest files. */
    recentLog(limit: number): Promise<LogEntry[]>;
}
//# sourceMappingURL=markdown-store.d.ts.map