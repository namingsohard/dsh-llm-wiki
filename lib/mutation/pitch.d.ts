import type { MutationOp } from '../types.js';
/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export declare function clampInline(text: string, max: number): string;
/** The first prose line of a body, skipping quote and heading markers. */
export declare function firstProseLine(body: string): string;
/** Render one mutation operation as `OP id — what changes (why it is worth keeping)`. */
export declare function renderOpPitch(op: MutationOp, detail?: string): string;
/** Render a staged source card as a single review line. */
export declare function renderSourcePitch(title: string, url: string | undefined): string;
/** One entry of the approval headline. */
export interface ApprovalLine {
    /** Upper-cased operation word, e.g. `SOURCE`, `CREATE`, `DEPRECATE`. */
    op: string;
    /** Human-readable subject: page title, or `id → target` for rewrites. */
    label: string;
    /** The extractor's stated reason, flattened and clamped. */
    reason: string;
}
/**
 * Render the approval prompt as one deliberate single line.
 *
 * The harness approval card puts `reason` in a plain div with the default
 * `white-space`, so newlines collapse to spaces and markdown never renders —
 * a multi-line pitch arrives as one unreadable wall of prose. Circled numbers
 * and `‖` separators keep the items apart however the card wraps, and the
 * detail that does not fit stays where newlines do work: in the tool result
 * (`wiki_review` rows) and in whatever the model put in its reply first.
 */
export declare function renderApprovalPitch(items: readonly ApprovalLine[]): string;
//# sourceMappingURL=pitch.d.ts.map