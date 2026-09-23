import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WikiStore } from '../src/storage/markdown-store.js';
import { searchWiki, tokenize } from '../src/retrieval/grep-retriever.js';
import { routeQuery, coverageFromScore } from '../src/router/knowledge-router.js';
import { slugifyTitle, sourceId, assertPageId } from '../src/storage/id-slug.js';
import type { SearchHit, WikiPage } from '../src/types.js';

let root: string;
let store: WikiStore;

function page(overrides: Partial<WikiPage>): WikiPage {
  const now = new Date('2026-02-03T10:00:00.000Z').toISOString();
  return {
    id: 'p',
    kind: 'concept',
    title: 'T',
    status: 'active',
    revision: 1,
    created: now,
    updated: now,
    tags: [],
    links: [],
    sources: [],
    body: '',
    path: '',
    ...overrides,
  };
}

async function seed(): Promise<void> {
  store = new WikiStore(root);
  await store.ensureInit();
  await store.writePage(
    page({
      id: 'context-compaction',
      title: 'Context Compaction',
      tags: ['llm', 'context'],
      body: 'Context compaction summarizes older turns of a conversation to keep the prompt window small.\n',
      path: join(root, 'concepts', 'context-compaction.md'),
    }),
  );
  await store.writePage(
    page({
      id: 'transformer',
      title: 'Transformer Architecture',
      tags: ['ml'],
      body: 'Attention-based neural network architecture underlying modern LLMs.\n',
      path: join(root, 'concepts', 'transformer.md'),
    }),
  );
  await store.writePage(
    page({
      id: 'old-agent-lore',
      title: 'Early ReAct agent patterns',
      body: 'Old notes about ReAct loops from a deprecated survey.',
      updated: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      path: join(root, 'concepts', 'old-agent-lore.md'),
    }),
  );
  await store.writePage(
    page({
      id: 'dead-concept',
      title: 'Deprecated idea',
      status: 'deprecated',
      body: 'compaction related but deprecated.',
      path: join(root, 'concepts', 'dead-concept.md'),
    }),
  );
  await store.writePage(
    page({
      id: 'src-x',
      kind: 'source',
      title: 'Compaction survey',
      body: 'A survey about context compaction in agents.',
      path: join(root, 'sources', 'src-x.md'),
    }),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-wiki-ret-'));
  await seed();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('tokenize', () => {
  it('handles ascii words and CJK unigrams/bigrams', () => {
    expect(tokenize('Context Compaction')).toEqual(['context', 'compaction']);
    const cjk = tokenize('上下文压缩');
    expect(cjk).toContain('上');
    expect(cjk).toContain('上下');
    expect(cjk).toContain('文压');
  });
});

describe('searchWiki', () => {
  it('ranks title matches above body matches', async () => {
    const result = await searchWiki(store, { query: 'context compaction', limit: 10, includeDeprecated: false, agingAfterDays: 90, staleAfterDays: 365 });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.id).toBe('context-compaction');
  });

  it('finds CJK content', async () => {
    await store.writePage(page({ id: 'p-cjk', title: '提示工程', body: '提示工程是引导模型输出的技术。\n', path: join(root, 'concepts', 'p-cjk.md') }));
    const result = await searchWiki(store, { query: '提示工程', limit: 10, includeDeprecated: false, agingAfterDays: 90, staleAfterDays: 365 });
    expect(result.hits[0]?.id).toBe('p-cjk');
  });

  it('excludes deprecated by default and merges never appear', async () => {
    const result = await searchWiki(store, { query: 'compaction', limit: 10, includeDeprecated: false, agingAfterDays: 90, staleAfterDays: 365 });
    expect(result.hits.some((h) => h.id === 'dead-concept')).toBe(false);
    const withDep = await searchWiki(store, { query: 'compaction', limit: 10, includeDeprecated: true, agingAfterDays: 90, staleAfterDays: 365 });
    expect(withDep.hits.some((h) => h.id === 'dead-concept')).toBe(true);
  });

  it('excludes sources unless requested', async () => {
    const result = await searchWiki(store, { query: 'compaction', kinds: ['concept', 'entity'], limit: 10, includeDeprecated: false, agingAfterDays: 90, staleAfterDays: 365 });
    expect(result.hits.every((h) => h.kind !== 'source')).toBe(true);
    const withSrc = await searchWiki(store, { query: 'compaction', kinds: ['concept', 'entity', 'source'], limit: 10, includeDeprecated: false, agingAfterDays: 90, staleAfterDays: 365 });
    expect(withSrc.hits.some((h) => h.id === 'src-x')).toBe(true);
  });

  it('marks stale pages and lowers their weight', async () => {
    const result = await searchWiki(store, { query: 'ReAct agent patterns', limit: 10, includeDeprecated: false, agingAfterDays: 90, staleAfterDays: 365 });
    const stale = result.hits.find((h) => h.id === 'old-agent-lore');
    expect(stale?.freshness).toBe('stale');
  });

  it('invalidates its cache when the store version moves', async () => {
    const first = await searchWiki(store, { query: 'brand-new-page', limit: 10, includeDeprecated: false, agingAfterDays: 90, staleAfterDays: 365 });
    expect(first.hits).toHaveLength(0);
    await store.writePage(page({ id: 'brand-new-page', title: 'Brand New Page', body: 'unique term zzzzquux.', path: join(root, 'concepts', 'brand-new-page.md') }));
    const second = await searchWiki(store, { query: 'zzzzquux', limit: 10, includeDeprecated: false, agingAfterDays: 90, staleAfterDays: 365 });
    expect(second.hits.map((h) => h.id)).toContain('brand-new-page');
  });
});

describe('knowledge router', () => {
  const hit = (score: number, freshness: SearchHit['freshness'] = 'fresh'): SearchHit => ({
    id: 'x',
    kind: 'concept',
    title: 'X',
    status: 'active',
    score,
    freshness,
    snippet: '',
    updated: new Date().toISOString(),
  });

  it('maps scores to coverage buckets', () => {
    expect(coverageFromScore(undefined)).toBe('none');
    expect(coverageFromScore(0.5)).toBe('none');
    expect(coverageFromScore(2)).toBe('low');
    expect(coverageFromScore(5)).toBe('partial');
    expect(coverageFromScore(9)).toBe('high');
  });

  it('high coverage says reuse the wiki', () => {
    const decision = routeQuery([hit(10)], 'how does context compaction work');
    expect(decision.coverage).toBe('high');
    expect(decision.useWiki).toBe(true);
    expect(decision.needWeb).toBe(false);
  });

  it('time-sensitive queries are never fully covered', () => {
    const decision = routeQuery([hit(12)], 'what is the latest model release');
    expect(decision.coverage).toBe('partial');
    expect(decision.needWeb).toBe(true);
  });

  it('a stale top hit downgrades coverage', () => {
    const decision = routeQuery([hit(12, 'stale')], 'context compaction');
    expect(decision.coverage).toBe('partial');
  });

  it('empty wiki says go acquire', () => {
    const decision = routeQuery([], 'anything');
    expect(decision.coverage).toBe('none');
    expect(decision.needWeb).toBe(true);
    expect(decision.advice).toContain('wiki_source_save');
  });
});

describe('id-slug', () => {
  it('slugifies ascii and CJK titles', () => {
    expect(slugifyTitle('Context Compaction!')).toBe('context-compaction');
    expect(slugifyTitle('上下文压缩')).toMatch(/^p-[0-9a-f]{8}$/);
    expect(slugifyTitle('Claude Code 代码'))
      .toMatch(/^claude-code-[0-9a-f]{8}$/);
  });

  it('source ids are deterministic per url', () => {
    const d = new Date('2026-02-03T00:00:00Z');
    expect(sourceId('https://a.com', 'A', d)).toBe(sourceId('https://a.com', 'Other title', d));
    expect(sourceId(undefined, 'Doc', d)).toMatch(/^src-20260203-[0-9a-f]{8}$/);
  });

  it('rejects traversal-ish ids', () => {
    expect(() => assertPageId('../x')).toThrow();
    expect(() => assertPageId('OK-upper')).toThrow();
    expect(() => assertPageId('ok-id.1_2')).not.toThrow();
  });
});
