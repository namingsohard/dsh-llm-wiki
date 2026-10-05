import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { WikiStore } from '../src/storage/markdown-store.js';
import { lintWiki } from '../src/validator/wiki-linter.js';
import type { WikiPage } from '../src/types.js';

const config = resolveConfig();
let root: string;
let store: WikiStore;

function page(overrides: Partial<WikiPage>): WikiPage {
  const now = new Date().toISOString();
  return { id: 'p', kind: 'concept', title: 'T', status: 'active', revision: 1, created: now, updated: now, tags: [], links: [], sources: [], body: 'text\n', path: '', ...overrides };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-wiki-lint-'));
  store = new WikiStore(root);
  await store.ensureInit();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('wiki linter', () => {
  it('reports nothing on an empty wiki', async () => {
    const report = await lintWiki(store, config);
    expect(report.issues).toHaveLength(0);
    expect(report.scanned).toBe(0);
  });

  it('flags broken links', async () => {
    await store.writePage(page({ id: 'a', title: 'A', links: [{ target: 'ghost' }], path: join(root, 'concepts', 'a.md') }));
    const report = await lintWiki(store, config);
    expect(report.issues.some((i) => i.check === 'broken-link' && i.page === 'a')).toBe(true);
  });

  it('flags duplicate titles and near-duplicates', async () => {
    await store.writePage(page({ id: 'x', title: 'Context Compaction', path: join(root, 'concepts', 'x.md') }));
    await store.writePage(page({ id: 'y', title: 'context  compaction!', path: join(root, 'concepts', 'y.md') }));
    const report = await lintWiki(store, config);
    expect(report.issues.some((i) => i.check === 'duplicate' && i.level === 'warn')).toBe(true);
  });

  it('does not flag unrelated pages as duplicates', async () => {
    await store.writePage(page({ id: 'x', title: 'Context Compaction', tags: ['llm'], path: join(root, 'concepts', 'x.md') }));
    await store.writePage(page({ id: 'z', title: 'Kubernetes Operators', tags: ['devops'], path: join(root, 'concepts', 'z.md') }));
    const report = await lintWiki(store, config);
    expect(report.issues.some((i) => i.check === 'duplicate')).toBe(false);
  });

  it('flags stale pages, links to deprecated pages, and orphans', async () => {
    const ancient = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await store.writePage(page({ id: 'fresh', title: 'Fresh', links: [{ target: 'old' }], path: join(root, 'concepts', 'fresh.md') }));
    await store.writePage(page({ id: 'old', title: 'Old', status: 'deprecated', updated: ancient, path: join(root, 'concepts', 'old.md') }));
    await store.writePage(page({ id: 'alone', title: 'Alone', updated: ancient, path: join(root, 'concepts', 'alone.md') }));
    const report = await lintWiki(store, config);
    expect(report.issues.some((i) => i.check === 'deprecated-ref' && i.page === 'fresh')).toBe(true);
    expect(report.issues.some((i) => i.check === 'stale' && i.page === 'alone')).toBe(true);
    expect(report.issues.some((i) => i.check === 'orphan' && i.page === 'alone')).toBe(true);
  });

  it('reports unparseable files without failing', async () => {
    await writeFile(join(root, 'concepts', 'corrupt.md'), 'not a page at all\n', 'utf8');
    const report = await lintWiki(store, config);
    expect(report.parseFailures).toHaveLength(1);
    expect(report.parseFailures[0]?.path).toContain('corrupt.md');
  });

  it('flags a source card no page cites, and stops when one does', async () => {
    await store.writePage(page({ id: 'fact', title: 'Fact', path: join(root, 'concepts', 'fact.md') }));
    await store.writePage(page({ id: 'src-20261004-aaaaaa11', kind: 'source', title: 'A guide', path: join(root, 'sources', 'src-20261004-aaaaaa11.md') }));
    const uncited = await lintWiki(store, config);
    expect(uncited.issues.some((i) => i.check === 'unreferenced-source' && i.page === 'src-20261004-aaaaaa11')).toBe(true);

    await store.writePage(page({ id: 'other', title: 'Other', path: join(root, 'concepts', 'other.md') }));
    await store.writePage(page({ id: 'fact', title: 'Fact', sources: ['src-20261004-aaaaaa11'], links: [{ target: 'other' }], path: join(root, 'concepts', 'fact.md') }));
    const cited = await lintWiki(store, config);
    expect(cited.issues.some((i) => i.check === 'unreferenced-source')).toBe(false);
  });

  it('counts a [[id]] mention as a link only when that family is enabled', async () => {
    await store.writePage(page({ id: 'hub', title: 'Hub', body: 'See [[lonely]] for the rest.\n', path: join(root, 'concepts', 'hub.md') }));
    await store.writePage(page({ id: 'lonely', title: 'Lonely', path: join(root, 'concepts', 'lonely.md') }));

    const off = await lintWiki(store, config);
    expect(off.issues.some((i) => i.check === 'orphan' && i.page === 'lonely')).toBe(true);

    const withMentions = resolveConfig({ wikiLinkEdges: true });
    const on = await lintWiki(store, withMentions);
    expect(on.issues.some((i) => i.check === 'orphan' && i.page === 'lonely')).toBe(false);
    expect(on.issues.some((i) => i.check === 'broken-link')).toBe(false);
  });

  it('names a [[id]] mention of a page that does not exist', async () => {
    await store.writePage(page({ id: 'stub', title: 'Stub', status: 'merged', body: '> Merged into **[[nowhere]] (Nowhere)**.\n', path: join(root, 'concepts', 'stub.md') }));
    const report = await lintWiki(store, resolveConfig({ wikiLinkEdges: true }));
    const finding = report.issues.find((i) => i.check === 'broken-link' && i.page === 'stub');
    expect(finding?.message).toContain('[[nowhere]]');
  });
});
