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
});
