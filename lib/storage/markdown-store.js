import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
export const KIND_DIRS = {
    concept: 'concepts',
    entity: 'entities',
    source: 'sources',
};
const ALL_KINDS = ['concept', 'entity', 'source'];
/** Atomic-write retry budget for transient Windows sharing violations. */
const RENAME_RETRIES = 4;
const RENAME_BACKOFF_MS = 25;
async function atomicWrite(path, content) {
    const tmp = `${path}.tmp-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmp, content, 'utf8');
    let lastError;
    for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
        try {
            await rename(tmp, path);
            return;
        }
        catch (error) {
            lastError = error;
            const code = error.code;
            if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')
                break;
            await new Promise((r) => setTimeout(r, RENAME_BACKOFF_MS * (attempt + 1)));
        }
    }
    throw lastError;
}
export class WikiStore {
    /** Bumped on every successful mutation; drives reader caches. */
    version = 0;
    root;
    logger;
    chain = Promise.resolve();
    initialized = false;
    constructor(root, logger) {
        this.root = root;
        this.logger = logger;
    }
    /**
     * Serialize a mutation through the in-process mutex. Rejections never break
     * the chain for later writers.
     */
    async withLock(task) {
        const run = this.chain.then(task, task);
        this.chain = run.catch(() => undefined);
        return await run;
    }
    /** Create the directory skeleton (idempotent). */
    async ensureInit() {
        if (this.initialized)
            return;
        await mkdir(join(this.root, 'concepts'), { recursive: true });
        await mkdir(join(this.root, 'entities'), { recursive: true });
        await mkdir(join(this.root, 'sources'), { recursive: true });
        await mkdir(join(this.root, 'logs'), { recursive: true });
        this.initialized = true;
    }
    /** On-disk location for a page id of the given kind. */
    pagePath(kind, id) {
        assertPageId(id);
        return join(this.root, KIND_DIRS[kind], `${id}.md`);
    }
    /** Read one page by id across all kinds. Returns undefined when absent. */
    async read(id) {
        assertPageId(id);
        for (const kind of ALL_KINDS) {
            const path = this.pagePath(kind, id);
            try {
                const page = parsePage(await readFile(path, 'utf8'), path);
                // Trust the directory over a drifted frontmatter kind.
                return page.kind === kind ? page : { ...page, kind };
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        }
        return undefined;
    }
    /** Write a page file atomically and bump the store version. */
    async writePage(page) {
        const text = serializePage(page, page.body);
        if (Buffer.byteLength(text, 'utf8') > Number.MAX_SAFE_INTEGER) {
            throw new Error(`page ${page.id} is unreasonably large`);
        }
        await atomicWrite(this.pagePath(page.kind, page.id), text);
        this.version++;
    }
    /** All page ids currently on disk, keyed by kind. */
    async listIds(kinds = ALL_KINDS) {
        const out = new Map();
        for (const kind of kinds) {
            let names;
            try {
                names = await readdir(join(this.root, KIND_DIRS[kind]));
            }
            catch {
                continue;
            }
            for (const name of names) {
                if (!name.endsWith('.md'))
                    continue;
                out.set(name.slice(0, -3), kind);
            }
        }
        return out;
    }
    /**
     * Load every page of the given kinds. Unparseable files are skipped and
     * reported; they never fail the listing.
     */
    async listPages(kinds = ALL_KINDS) {
        const ids = await this.listIds(kinds);
        const pages = [];
        const failures = [];
        for (const [id, kind] of ids) {
            const path = this.pagePath(kind, id);
            try {
                pages.push(parsePage(await readFile(path, 'utf8'), path));
            }
            catch (error) {
                const failure = { path, message: error instanceof Error ? error.message : String(error) };
                failures.push(failure);
                this.logger?.warn?.('dsh-llm-wiki: unreadable page %s: %s', path, failure.message);
            }
        }
        return { pages, failures };
    }
    /** Rebuild `index.md` from the current page set. */
    async rebuildIndex() {
        const { pages } = await this.listPages();
        const byKind = (kind) => pages
            .filter((page) => page.kind === kind && page.status === 'active')
            .sort((a, b) => a.title.localeCompare(b.title));
        const archived = pages
            .filter((page) => page.kind !== 'source' && page.status !== 'active')
            .sort((a, b) => a.title.localeCompare(b.title));
        const line = (page) => `- [${page.id}](./${KIND_DIRS[page.kind]}/${page.id}.md) — ${page.title}` +
            (page.status === 'active' ? '' : ` _(${page.status})_`) +
            ` · updated ${page.updated.slice(0, 10)}` +
            (page.supersededBy === undefined ? '' : ` · → ${page.supersededBy}`);
        const sections = [
            '# DSH-Wiki Index',
            '',
            '<!-- Generated by dsh-llm-wiki. Do not edit by hand; it is rewritten on every mutation. -->',
            '',
            `_${pages.length} page(s); wiki root: ${this.root}_`,
            '',
        ];
        const pushSection = (heading, list) => {
            sections.push(`## ${heading}`, '');
            if (list.length === 0)
                sections.push('_No pages yet._');
            else
                sections.push(...list.map(line));
            sections.push('');
        };
        pushSection('Concepts', byKind('concept'));
        pushSection('Entities', byKind('entity'));
        pushSection('Sources', byKind('source'));
        pushSection('Deprecated / Merged', archived);
        await atomicWrite(join(this.root, 'index.md'), `${sections.join('\n').trimEnd()}\n`);
    }
    /** Append entries to today's mutation journal (`logs/YYYY-MM-DD.jsonl`). */
    async appendLog(entries) {
        if (entries.length === 0)
            return;
        await mkdir(join(this.root, 'logs'), { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        const path = join(this.root, 'logs', `${day}.jsonl`);
        let existing = '';
        try {
            existing = await readFile(path, 'utf8');
        }
        catch {
            existing = '';
        }
        const appended = `${existing}${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
        await atomicWrite(path, appended);
    }
    /** Recent journal lines, newest last, across the newest files. */
    async recentLog(limit) {
        let names;
        try {
            names = (await readdir(join(this.root, 'logs'))).filter((name) => name.endsWith('.jsonl')).sort();
        }
        catch {
            return [];
        }
        const out = [];
        for (const name of names.reverse()) {
            if (out.length >= limit)
                break;
            let text = '';
            try {
                text = await readFile(join(this.root, 'logs', name), 'utf8');
            }
            catch {
                continue;
            }
            const lines = text.split('\n').filter((line) => line.trim().length > 0).reverse();
            for (const line of lines) {
                if (out.length >= limit)
                    break;
                try {
                    out.push(JSON.parse(line));
                }
                catch {
                    // A torn line (crash mid-append) is skipped.
                }
            }
        }
        return out.reverse();
    }
}
//# sourceMappingURL=markdown-store.js.map