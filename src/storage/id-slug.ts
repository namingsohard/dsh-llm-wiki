/**
 * Id/slug helpers. Page ids are filenames, so they must be traversal-proof:
 * lowercase ASCII slugs with a strict allowlist. Titles outside that range
 * (e.g. pure CJK) fall back to a stable hash suffix.
 *
 * @module dsh-llm-wiki/storage/id-slug
 */

/** Grammar every page id must satisfy. Deliberately excludes `/`, `\`, and `:`. */
export const PAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/** Throw when an id cannot safely name a wiki file. */
export function assertPageId(id: string): void {
  if (!PAGE_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid wiki page id ${JSON.stringify(id)}: ids match ${PAGE_ID_PATTERN} (lowercase letters, digits, '.', '_', '-')`,
    );
  }
}

/** True when the id is structurally valid. */
export function isValidPageId(id: string): boolean {
  return PAGE_ID_PATTERN.test(id);
}

/** FNV-1a 32-bit hash rendered as 8 hex chars. Stable, dependency-free. */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const WHITESPACE = /\s+/g;

/**
 * Derive a page id from a title. ASCII words are slugified; when nothing
 * survives transliteration (CJK-only or symbolic titles) the slug is suffixed
 * with a content hash so distinct titles never collide on stripped empties.
 */
export function slugifyTitle(title: string): string {
  const base = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, ' ')
    .split(WHITESPACE)
    .filter((word) => word.length > 0)
    .join('-')
    .slice(0, 72);
  const hasCjk = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(title);
  if (base.length === 0) return `p-${shortHash(title)}`;
  if (hasCjk) return `${base}-${shortHash(title)}`;
  return base;
}

/** Deterministic id for a saved source: `src-<yyyymmdd>-<hash8>`. */
export function sourceId(url: string | undefined, title: string, obtained: Date): string {
  const key = url !== undefined && url.length > 0 ? url : `title:${title}`;
  const ymd = obtained.toISOString().slice(0, 10).replaceAll('-', '');
  return `src-${ymd}-${shortHash(key)}`;
}
