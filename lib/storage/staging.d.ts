import type { MutationOp, PageKind } from '../types.js';
/**
 * The write gate's holding area: `<wiki root>/staging/`.
 *
 * Every proposed write lands here as one JSON envelope before it can reach the
 * live layers, so an unapproved proposal never shows up in `wiki_search`,
 * `wiki_lint`, or `index.md`. The linter reads only the three kind
 * directories, which is what makes staging inert by construction.
 *
 * Entry ids are stable across sessions (`<kind>-<hash8>`), so re-proposing the
 * same source or the same mutation replaces its entry instead of piling up
 * duplicates.
 *
 * @module dsh-llm-wiki/storage/staging
 */
/** What kind of write a staged entry holds. */
export type StageKind = 'source' | PageKind;
/** One proposed write waiting for the user's decision. */
export interface StagedEntry {
    /** Stable pending id, e.g. `src-1a2b3c4d` or `pg-9f8e7d6c`; what `wiki_review` keys on. */
    id: string;
    kind: StageKind;
    /** What this entry becomes: a source page or a mutation operation. */
    type: 'source' | 'mutation';
    /** The proposed write: `{ title, url, obtained, content }` or a {@link MutationOp}. */
    payload: unknown;
    /** One-paragraph pitch shown to the user. */
    pitch: string;
    /** Why the model thinks this belongs in the wiki (its own words). */
    reason?: string;
    /** Admission verdict computed at stage time; the controller still decides at promote time. */
    admission?: {
        average: number;
        minimum: number;
        accept: boolean;
    };
    /** The model's own admission scores, when it supplied any. */
    scores?: Record<string, number>;
    /** ISO-8601 staging timestamp. */
    staged_at: string;
}
export interface StageInput {
    kind: StageKind;
    type: StagedEntry['type'];
    payload: unknown;
    pitch: string;
    reason?: string;
    admission?: StagedEntry['admission'];
    scores?: Record<string, number>;
    stagedAt?: string;
}
/** Deterministic entry id for a staged source proposal. */
export declare function stagedSourceId(url: string | undefined, title: string): string;
/** Deterministic entry id for a staged mutation proposal. */
export declare function stagedMutationId(op: MutationOp): string;
/**
 * Filesystem-backed staging queue. Writes are atomic (temp + rename) and the
 * queue is ordered by staging time, oldest first.
 */
export declare class StagingQueue {
    readonly dir: string;
    constructor(root: string);
    ensure(): Promise<void>;
    private path;
    /** All pending entries, oldest first; unreadable files are skipped. */
    list(): Promise<{
        entries: StagedEntry[];
        skipped: number;
    }>;
    /** Read one entry by id. */
    read(id: string): Promise<StagedEntry | undefined>;
    /** Write (or replace) one entry atomically. */
    put(input: StageInput): Promise<StagedEntry>;
    /** Drop entries after a decision (or an explicit discard). Missing files are fine. */
    drop(ids: readonly string[]): Promise<void>;
}
//# sourceMappingURL=staging.d.ts.map