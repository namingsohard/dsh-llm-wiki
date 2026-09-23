/**
 * Id/slug helpers. Page ids are filenames, so they must be traversal-proof:
 * lowercase ASCII slugs with a strict allowlist. Titles outside that range
 * (e.g. pure CJK) fall back to a stable hash suffix.
 *
 * @module dsh-llm-wiki/storage/id-slug
 */
/** Grammar every page id must satisfy. Deliberately excludes `/`, `\`, and `:`. */
export declare const PAGE_ID_PATTERN: RegExp;
/** Throw when an id cannot safely name a wiki file. */
export declare function assertPageId(id: string): void;
/** True when the id is structurally valid. */
export declare function isValidPageId(id: string): boolean;
/** FNV-1a 32-bit hash rendered as 8 hex chars. Stable, dependency-free. */
export declare function shortHash(input: string): string;
/**
 * Derive a page id from a title. ASCII words are slugified; when nothing
 * survives transliteration (CJK-only or symbolic titles) the slug is suffixed
 * with a content hash so distinct titles never collide on stripped empties.
 */
export declare function slugifyTitle(title: string): string;
/** Deterministic id for a saved source: `src-<yyyymmdd>-<hash8>`. */
export declare function sourceId(url: string | undefined, title: string, obtained: Date): string;
/** Content hash of raw material, used for source deduplication. */
export declare function contentHash(content: string): string;
//# sourceMappingURL=id-slug.d.ts.map