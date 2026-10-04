import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WikiStore } from '../src/storage/markdown-store.js';
import { parsePage, serializePage } from '../src/storage/page-format.js';
import type { WikiPage } from '../src/types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-wiki-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function samplePage(overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date('2026-02-03T10:00:00.000Z').toISOString();
  return {
    id: 'context-compaction',
    kind: 'concept',
    title: 'Context Compaction',
    status: 'active',
    revision: 3,
    created: now,
    updated: now,
    tags: ['llm', 'context'],
    links: [{ target: 'transformer' }, { target: 'dsh', relation: 'used by' }],
    sources: ['src-20260203-abcd1234'],
    body: 'Definition first.\n\nKey points.\n',
    path: '',
    ...overrides,
  };
}

describe('page-format', () => {
  it('round-trips a page losslessly', () => {
    const page = samplePage();
    const parsed = parsePage(serializePage(page, page.body), 'inline');
    expect(parsed.id).toBe(page.id);
    expect(parsed.kind).toBe('concept');
    expect(parsed.title).toBe('Context Compaction');
    expect(parsed.status).toBe('active');
    expect(parsed.revision).toBe(3);
    expect(parsed.tags).toEqual(['llm', 'context']);
    expect(parsed.links).toEqual([{ target: 'transformer' }, { target: 'dsh', relation: 'used by' }]);
    expect(parsed.sources).toEqual(['src-20260203-abcd1234']);
    expect(parsed.body).toBe(page.body);
  });

  it('preserves titles with colons and quotes', () => {
    const page = samplePage({ title: 'Harness: "the" plugin — design', id: 'weird-title' });
    const parsed = parsePage(serializePage(page, 'body\n'), 'inline');
    expect(parsed.title).toBe('Harness: "the" plugin — design');
  });

  it('preserves CJK content', () => {
    const page = samplePage({ id: 'p-12345678', title: '上下文压缩', body: '核心观点：压缩历史对话以节省 token。\n' });
    const parsed = parsePage(serializePage(page, page.body), 'inline');
    expect(parsed.title).toBe('上下文压缩');
    expect(parsed.body).toContain('核心观点');
  });

  it('keeps source fields', () => {
    const page = samplePage({
      kind: 'source',
      id: 'src-20260203-11111111',
      url: 'https://example.com/a?x=1&y=2',
      obtained: '2026-02-03T09:00:00.000Z',
      tags: ['hash:deadbeef'],
    });
    const parsed = parsePage(serializePage(page, 'raw\n'), 'inline');
    expect(parsed.url).toBe('https://example.com/a?x=1&y=2');
    expect(parsed.obtained).toBe('2026-02-03T09:00:00.000Z');
  });

  it('rejects missing frontmatter and bad kinds', () => {
    expect(() => parsePage('no frontmatter\n', 'x')).toThrow(/missing frontmatter/);
    const bad = serializePage(samplePage(), 'body').replace('kind: concept', 'kind: spell');
    expect(() => parsePage(bad, 'x')).toThrow(/unknown kind/);
  });

  it('ignores unknown frontmatter keys', () => {
    const text = serializePage(samplePage(), 'body\n').replace('---\nbody', 'future: 42\n---\nbody');
    expect(() => parsePage(text, 'inline')).not.toThrow();
  });
});

describe('markdown-store', () => {
  it('writes, reads, and lists pages across kinds', async () => {
    const store = new WikiStore(root);
    await store.ensureInit();
    const page = samplePage();
    await store.writePage({ ...page, path: store.pagePath('concept', page.id) });
    await store.writePage({ ...samplePage({ id: 'claude-code', kind: 'entity', title: 'Claude Code' }), path: store.pagePath('entity', 'claude-code') });

    const read = await store.read('context-compaction');
    expect(read?.title).toBe('Context Compaction');
    expect(await store.read('missing-page')).toBeUndefined();

    const ids = await store.listIds();
    expect([...ids.keys()].sort()).toEqual(['claude-code', 'context-compaction']);
    expect(ids.get('claude-code')).toBe('entity');
  });

  it('bumps version on write so reader caches invalidate', async () => {
    const store = new WikiStore(root);
    await store.ensureInit();
    const before = store.version;
    await store.writePage(samplePage({ path: join(root, 'concepts', 'context-compaction.md') }));
    expect(store.version).toBeGreaterThan(before);
  });

  it('rebuilds index.md listing every page', async () => {
    const store = new WikiStore(root);
    await store.ensureInit();
    await store.writePage(samplePage({ path: join(root, 'concepts', 'context-compaction.md') }));
    await store.rebuildIndex();
    const { readFile } = await import('node:fs/promises');
    const index = await readFile(join(root, 'index.md'), 'utf8');
    expect(index).toContain('## Concepts');
    expect(index).toContain('context-compaction');
  });

  it('rejects ids that could escape the root', async () => {
    const store = new WikiStore(root);
    expect(() => store.pagePath('concept', '../evil')).toThrow(/invalid wiki page id/);
    expect(() => store.pagePath('concept', 'a/b')).toThrow(/invalid wiki page id/);
    expect(() => store.pagePath('concept', '..')).toThrow(/invalid wiki page id/);
  });

  it('appends and reads back the mutation journal', async () => {
    const store = new WikiStore(root);
    await store.ensureInit();
    await store.appendLog([{ ts: 'x', op: 'create', pages: ['a'], result: 'applied' }]);
    await store.appendLog([{ ts: 'y', op: 'link', pages: ['a', 'b'], result: 'applied' }]);
    const recent = await store.recentLog(10);
    expect(recent.map((entry) => entry.op)).toEqual(['create', 'link']);
  });

  it('serializes writes through the lock', async () => {
    const store = new WikiStore(root);
    await store.ensureInit();
    const order: number[] = [];
    await Promise.all([
      store.withLock(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      }),
      store.withLock(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});
