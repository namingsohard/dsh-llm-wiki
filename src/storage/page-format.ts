import type { PageKind, PageStatus, WikiLink, WikiPage, WikiPageMeta } from '../types.js';
import { assertPageId } from './id-slug.js';

/**
 * Canonical page serialization: a constrained line-based frontmatter block
 * followed by the Markdown body. The grammar is intentionally tiny (scalars,
 * inline arrays, JSON-quoted strings) so round-tripping needs no YAML
 * dependency and a human can hand-edit pages safely.
 *
 * @module dsh-llm-wiki/storage/page-format
 */

/** Thrown when a file cannot be parsed as a wiki page. */
export class PageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageFormatError';
  }
}

const KINDS: readonly PageKind[] = ['concept', 'entity', 'source'];
const STATUSES: readonly PageStatus[] = ['active', 'deprecated', 'merged'];

/** A bare slug may be serialized unquoted. */
const BARE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._\-\/ ]*$/;

function scalarOut(value: string): string {
  if (value.length === 0) return '""';
  if (BARE_TOKEN.test(value) && !/^\s|\s$/.test(value)) return value;
  return JSON.stringify(value);
}

function arrayOut(values: readonly string[]): string {
  if (values.length === 0) return '[]';
  return `[${values.map((value) => (BARE_TOKEN.test(value) && !/^\s|\s$/.test(value) ? value : JSON.stringify(value))).join(', ')}]`;
}

/** Split an inline array body on top-level commas, honoring quoted entries. */
function splitInlineArray(body: string, context: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;
  for (const ch of body) {
    if (inQuotes) {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inQuotes = false;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      current += ch;
    } else if (ch === ',') {
      const trimmed = current.trim();
      if (trimmed.length > 0) out.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) out.push(trimmed);
  if (inQuotes) throw new PageFormatError(`${context}: unterminated quote in inline array`);
  return out.map((item) => decodeScalar(item, context));
}

function decodeScalar(raw: string, context: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== 'string') throw new Error('not a string');
      return parsed;
    } catch (error) {
      throw new PageFormatError(`${context}: bad quoted value: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return trimmed;
}

/** Serialize frontmatter + body into canonical page text. */
export function serializePage(meta: WikiPageMeta, body: string): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${meta.id}`);
  lines.push(`kind: ${meta.kind}`);
  lines.push(`title: ${scalarOut(meta.title)}`);
  lines.push(`status: ${meta.status}`);
  lines.push(`revision: ${meta.revision}`);
  lines.push(`created: ${meta.created}`);
  lines.push(`updated: ${meta.updated}`);
  lines.push(`tags: ${arrayOut(meta.tags)}`);
  lines.push(
    `links: ${arrayOut(
      meta.links.map((link) => (link.relation === undefined || link.relation.length === 0 ? link.target : `${link.target} | ${link.relation}`)),
    )}`,
  );
  lines.push(`sources: ${arrayOut(meta.sources)}`);
  if (meta.url !== undefined) lines.push(`url: ${scalarOut(meta.url)}`);
  if (meta.obtained !== undefined) lines.push(`obtained: ${scalarOut(meta.obtained)}`);
  if (meta.supersededBy !== undefined) lines.push(`superseded_by: ${scalarOut(meta.supersededBy)}`);
  lines.push('---');
  return `${lines.join('\n')}\n${body}`;
}

/** Parse page text back into a {@link WikiPage}. Unknown frontmatter keys are ignored. */
export function parsePage(text: string, path: string): WikiPage {
  const context = `wiki page ${path}`;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new PageFormatError(`${context}: missing frontmatter`);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new PageFormatError(`${context}: unterminated frontmatter`);

  const scalars = new Map<string, string>();
  const arrays = new Map<string, string[]>();
  for (const line of lines.slice(1, end)) {
    if (line.trim().length === 0) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (match === null) throw new PageFormatError(`${context}: bad frontmatter line ${JSON.stringify(line)}`);
    const key = match[1] as string;
    const raw = (match[2] ?? '').trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      arrays.set(key, splitInlineArray(raw.slice(1, -1), context));
    } else if (raw.length === 0) {
      scalars.set(key, '');
    } else {
      scalars.set(key, decodeScalar(raw, context));
    }
  }

  const id = scalars.get('id') ?? '';
  const kind = scalars.get('kind') ?? '';
  const status = scalars.get('status') ?? 'active';
  const title = scalars.get('title') ?? '';
  if (!KINDS.includes(kind as PageKind)) throw new PageFormatError(`${context}: unknown kind ${JSON.stringify(kind)}`);
  if (!STATUSES.includes(status as PageStatus)) throw new PageFormatError(`${context}: unknown status ${JSON.stringify(status)}`);
  try {
    assertPageId(id);
  } catch (error) {
    throw new PageFormatError(`${context}: ${(error as Error).message}`);
  }

  const links: WikiLink[] = (arrays.get('links') ?? []).map((entry) => {
    const bar = entry.indexOf('|');
    if (bar < 0) return { target: entry.trim() };
    return { target: entry.slice(0, bar).trim(), relation: entry.slice(bar + 1).trim() };
  });

  const revision = Number(scalars.get('revision') ?? '1');
  const created = scalars.get('created') ?? '';
  const updated = scalars.get('updated') ?? created;
  const now = new Date().toISOString();

  const meta: WikiPageMeta = {
    id,
    kind: kind as PageKind,
    title: title.length > 0 ? title : id,
    status: status as PageStatus,
    revision: Number.isInteger(revision) && revision > 0 ? revision : 1,
    created: created.length > 0 ? created : now,
    updated: updated.length > 0 ? updated : now,
    tags: arrays.get('tags') ?? [],
    links,
    sources: arrays.get('sources') ?? [],
  };
  const url = scalars.get('url');
  if (url !== undefined && url.length > 0) meta.url = url;
  const obtained = scalars.get('obtained');
  if (obtained !== undefined && obtained.length > 0) meta.obtained = obtained;
  const supersededBy = scalars.get('superseded_by');
  if (supersededBy !== undefined && supersededBy.length > 0) meta.supersededBy = supersededBy;

  return { ...meta, body: lines.slice(end + 1).join('\n'), path };
}
