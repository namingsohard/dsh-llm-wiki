import type { WikiPage, WikiPageMeta } from '../types.js';
/**
 * Canonical page serialization: a constrained line-based frontmatter block
 * followed by the Markdown body. The grammar is intentionally tiny (scalars,
 * inline arrays, JSON-quoted strings) so round-tripping needs no YAML
 * dependency and a human can hand-edit pages safely.
 *
 * @module dsh-llm-wiki/storage/page-format
 */
/** Thrown when a file cannot be parsed as a wiki page. */
export declare class PageFormatError extends Error {
    constructor(message: string);
}
/** Serialize frontmatter + body into canonical page text. */
export declare function serializePage(meta: WikiPageMeta, body: string): string;
/** Parse page text back into a {@link WikiPage}. Unknown frontmatter keys are ignored. */
export declare function parsePage(text: string, path: string): WikiPage;
//# sourceMappingURL=page-format.d.ts.map