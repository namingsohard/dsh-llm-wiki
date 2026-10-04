import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogEntry, PageKind, WikiPage } from '../types.js';
import { assertPageId } from './id-slug.js';
import { parsePage, serializePage } from './page-format.js';

/**
 * Filesystem-backed wiki storage. Layout (root defaults to `~/.dsh/wiki`):
 *
 *   index.md          generated table of contents
 *   concepts/<id>.md  abstract knowledge
 *   entities/<id>.md  concrete objects
 *   sources/<id>.md   source cards: link + retrieval time, never the text
 *   logs/<date>.jsonl mutation journal
 *   staging/*.json    write-gate proposals (managed by storage/staging.ts)
 *
 * Writes are atomic (temp file + rename) and serialized through an
 * in-process mutex. `version` increments on every successful write so
 * readers can cache listings between mutations.
 *
 * @module dsh-llm-wiki/storage/markdown-store
 */

/** Directory per page kind. */
export const KIND_DIRS: Record<PageKind, string> = {
  concept: 'concepts',
  entity: 'entities',
  source: 'sources',
};

const ALL_KINDS: readonly PageKind[] = ['concept', 'entity', 'source'];

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

/** Atomic-write retry budget for transient Windows sharing violations. */
const RENAME_RETRIES = 4;
const RENAME_BACKOFF_MS = 25;

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, content, 'utf8');
  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break;
      await new Promise((r) => setTimeout(r, RENAME_BACKOFF_MS * (attempt + 1)));
    }
  }
  throw lastError;
}

export class WikiStore {
  /** Bumped on every successful mutation; drives reader caches. */
  version = 0;
  readonly root: string;
  private readonly logger: StoreLogger | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private initialized = false;

  constructor(root: string, logger?: StoreLogger | undefined) {
    this.root = root;
    this.logger = logger;
  }

  /**
   * Serialize a mutation through the in-process mutex. Rejections never break
   * the chain for later writers.
   */
  async withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return await run;
  }

  /** Create the directory skeleton (idempotent). */
  async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await mkdir(join(this.root, 'concepts'), { recursive: true });
    await mkdir(join(this.root, 'entities'), { recursive: true });
    await mkdir(join(this.root, 'sources'), { recursive: true });
    await mkdir(join(this.root, 'logs'), { recursive: true });
    this.initialized = true;
  }

  /** On-disk location for a page id of the given kind. */
  pagePath(kind: PageKind, id: string): string {
    assertPageId(id);
    return join(this.root, KIND_DIRS[kind], `${id}.md`);
  }

  /** Read one page by id across all kinds. Returns undefined when absent. */
  async read(id: string): Promise<WikiPage | undefined> {
    assertPageId(id);
    for (const kind of ALL_KINDS) {
      const path = this.pagePath(kind, id);
      try {
        const page = parsePage(await readFile(path, 'utf8'), path);
        // Trust the directory over a drifted frontmatter kind.
        return page.kind === kind ? page : { ...page, kind };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return undefined;
  }

  /** Write a page file atomically and bump the store version. */
  async writePage(page: WikiPage): Promise<void> {
    const text = serializePage(page, page.body);
    if (Buffer.byteLength(text, 'utf8') > Number.MAX_SAFE_INTEGER) {
      throw new Error(`page ${page.id} is unreasonably large`);
    }
    await atomicWrite(this.pagePath(page.kind, page.id), text);
    this.version++;
  }

  /** All page ids currently on disk, keyed by kind. */
  async listIds(kinds: readonly PageKind[] = ALL_KINDS): Promise<Map<string, PageKind>> {
    const out = new Map<string, PageKind>();
    for (const kind of kinds) {
      let names: string[];
      try {
        names = await readdir(join(this.root, KIND_DIRS[kind]));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.md')) continue;
        out.set(name.slice(0, -3), kind);
      }
    }
    return out;
  }

  /**
   * Load every page of the given kinds. Unparseable files are skipped and
   * reported; they never fail the listing.
   */
  async listPages(kinds: readonly PageKind[] = ALL_KINDS): Promise<{ pages: WikiPage[]; failures: ParseFailure[] }> {
    const ids = await this.listIds(kinds);
    const pages: WikiPage[] = [];
    const failures: ParseFailure[] = [];
    for (const [id, kind] of ids) {
      const path = this.pagePath(kind, id);
      try {
        pages.push(parsePage(await readFile(path, 'utf8'), path));
      } catch (error) {
        const failure = { path, message: error instanceof Error ? error.message : String(error) };
        failures.push(failure);
        this.logger?.warn?.('dsh-llm-wiki: unreadable page %s: %s', path, failure.message);
      }
    }
    return { pages, failures };
  }

  /** Rebuild `index.md` from the current page set. */
  async rebuildIndex(): Promise<void> {
    const { pages } = await this.listPages();
    const byKind = (kind: PageKind) =>
      pages
        .filter((page) => page.kind === kind && page.status === 'active')
        .sort((a, b) => a.title.localeCompare(b.title));
    const archived = pages
      .filter((page) => page.kind !== 'source' && page.status !== 'active')
      .sort((a, b) => a.title.localeCompare(b.title));

    const line = (page: WikiPage): string =>
      `- [${page.id}](./${KIND_DIRS[page.kind]}/${page.id}.md) — ${page.title}` +
      (page.status === 'active' ? '' : ` _(${page.status})_`) +
      ` · updated ${page.updated.slice(0, 10)}` +
      (page.supersededBy === undefined ? '' : ` · → ${page.supersededBy}`);

    const sections: string[] = [
      '# DSH-Wiki Index',
      '',
      '<!-- Generated by dsh-llm-wiki. Do not edit by hand; it is rewritten on every mutation. -->',
      '',
      `_${pages.length} page(s); wiki root: ${this.root}_`,
      '',
    ];
    const pushSection = (heading: string, list: WikiPage[]): void => {
      sections.push(`## ${heading}`, '');
      if (list.length === 0) sections.push('_No pages yet._');
      else sections.push(...list.map(line));
      sections.push('');
    };
    pushSection('Concepts', byKind('concept'));
    pushSection('Entities', byKind('entity'));
    pushSection('Sources', byKind('source'));
    pushSection('Deprecated / Merged', archived);

    await atomicWrite(join(this.root, 'index.md'), `${sections.join('\n').trimEnd()}\n`);
  }

  /** Append entries to today's mutation journal (`logs/YYYY-MM-DD.jsonl`). */
  async appendLog(entries: readonly LogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await mkdir(join(this.root, 'logs'), { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const path = join(this.root, 'logs', `${day}.jsonl`);
    let existing = '';
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      existing = '';
    }
    const appended = `${existing}${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    await atomicWrite(path, appended);
  }

  /** Recent journal lines, newest last, across the newest files. */
  async recentLog(limit: number): Promise<LogEntry[]> {
    let names: string[];
    try {
      names = (await readdir(join(this.root, 'logs'))).filter((name) => name.endsWith('.jsonl')).sort();
    } catch {
      return [];
    }
    const out: LogEntry[] = [];
    for (const name of names.reverse()) {
      if (out.length >= limit) break;
      let text = '';
      try {
        text = await readFile(join(this.root, 'logs', name), 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n').filter((line) => line.trim().length > 0).reverse();
      for (const line of lines) {
        if (out.length >= limit) break;
        try {
          out.push(JSON.parse(line) as LogEntry);
        } catch {
          // A torn line (crash mid-append) is skipped.
        }
      }
    }
    return out.reverse();
  }
}
