import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WikiStore } from '../src/storage/markdown-store.js';
import { searchWiki, tokenize, queryTokens, tokenWeight } from '../src/retrieval/grep-retriever.js';
import { routeQuery, coverageFromScore, isTimeSensitive } from '../src/router/knowledge-router.js';
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

describe('query-side tokens', () => {
  it('drops function words, which matched anything and answered nothing', () => {
    expect(queryTokens('what is the best way to compact context')).toEqual(['best', 'way', 'compact', 'context']);
    // A query that is nothing but function words keeps its tokens.
    expect(queryTokens('the and of')).toEqual(['the', 'and', 'of']);
  });

  it('discounts a lone Han character against a bigram or a word', () => {
    expect(tokenWeight('地')).toBeLessThan(tokenWeight('地图'));
    expect(tokenWeight('地图')).toBe(tokenWeight('planet'));
  });
});

// The bug this guards: one shared word was enough for the router to send the
// agent to read an unrelated page, and then to fold a new subject into it.
describe('coverage honesty', () => {
  const search = (query: string) =>
    searchWiki(store, { query, limit: 10, includeDeprecated: false, agingAfterDays: 90, staleAfterDays: 365 });

  async function seedEarth(): Promise<void> {
    await store.writePage(page({
      id: 'earth',
      title: 'Earth as a Planet',
      tags: ['astronomy'],
      body: 'Earth is the third planet from the Sun; its mass and orbit are typical of terrestrial planets.\n',
      path: join(root, 'concepts', 'earth.md'),
    }));
  }

  it('reads an Earth page as background for a question about maps', async () => {
    await seedEarth();
    const result = await search('map projections of the earth surface');
    const decision = routeQuery(result.hits, 'map projections of the earth surface');
    expect(result.hits.map((h) => h.id)).toContain('earth'); // visible as background
    expect(decision.coverage).toBe('low'); // but not an answer to read first
    expect(decision.needWeb).toBe(true);
  });

  it('still reads the same page as full coverage when the query is about it', async () => {
    await seedEarth();
    const result = await search('earth planet mass');
    expect(routeQuery(result.hits, 'earth planet mass').coverage).toBe('high');
  });

  it('does not let one shared Han character carry the coverage', async () => {
    await store.writePage(page({
      id: 'diqiu',
      title: '地球',
      body: '地球是太阳系第三颗行星。\n',
      path: join(root, 'concepts', 'diqiu.md'),
    }));
    const query = '地图 地理';
    const result = await search(query);
    const decision = routeQuery(result.hits, query);
    expect(result.hits.map((h) => h.id)).toContain('diqiu');
    expect(decision.coverage).toBe('low');
  });

  it('reports the match evidence with every hit', async () => {
    await seedEarth();
    const [top] = (await search('earth planet mass')).hits;
    expect(top?.match).toEqual({ matched: 3, total: 3, strong: 2 });
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
  const hit = (score: number, freshness: SearchHit['freshness'] = 'fresh', match: SearchHit['match'] = { matched: 3, total: 3, strong: 3 }): SearchHit => ({
    id: 'x',
    kind: 'concept',
    title: 'X',
    status: 'active',
    score,
    match,
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

  // Regression: a page about Earth used to read as `partial` coverage for a
  // question about maps. One shared word in the title scored 4, and 3 was the
  // whole bar — nothing asked how much of the question that page answered.
  it('will not call one incidental term partial coverage', () => {
    expect(coverageFromScore(4, { matched: 1, total: 3, strong: 1 })).toBe('low');
    expect(coverageFromScore(9, { matched: 1, total: 8, strong: 1 })).toBe('low');
    // Same score, most of the question actually matched: still partial/high.
    expect(coverageFromScore(4, { matched: 2, total: 3, strong: 0 })).toBe('partial');
    expect(coverageFromScore(9, { matched: 6, total: 8, strong: 2 })).toBe('high');
  });

  it('needs a title or tag term for high coverage', () => {
    // Everything matched somewhere in the body of a long page: not an answer.
    expect(coverageFromScore(10, { matched: 6, total: 6, strong: 0 })).toBe('partial');
  });

  it('reports high when the query is fully covered in the title', () => {
    const decision = routeQuery([hit(14, 'fresh', { matched: 2, total: 2, strong: 2 })], 'context compaction');
    expect(decision.coverage).toBe('high');
    expect(decision.useWiki).toBe(true);
    expect(decision.needWeb).toBe(false);
  });

  it('partial hands the reading of the evidence to the agent', () => {
    const decision = routeQuery([hit(5, 'fresh', { matched: 2, total: 4, strong: 1 })], 'how does compaction work');
    expect(decision.coverage).toBe('partial');
    // It must present the evidence and both branches, not order a wiki_inspect.
    expect(decision.advice).toMatch(/matched 2\/4 of your query terms/);
    expect(decision.advice).toMatch(/you know the question, the score does not/);
    expect(decision.advice).toMatch(/Different subject/);
    expect(decision.advice).toMatch(/CREATE its own page/);
    expect(decision.nextStep.startsWith('wiki_inspect')).toBe(false);
    expect(decision.needWeb).toBe(true);
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

  // Regression: JS \b only counts [A-Za-z0-9_] as word characters, so the old
  // single regex could never match a CJK time term inside natural Chinese.
  it('detects CJK time terms without ascii word boundaries', () => {
    expect(isTimeSensitive('最新的 dsh plugin API')).toBe(true);
    expect(isTimeSensitive('dsh 最新的插件 API 是什么')).toBe(true);
    expect(isTimeSensitive('今天天气怎么样')).toBe(true);
    expect(isTimeSensitive('当前配置的默认值')).toBe(true);
    expect(isTimeSensitive('2025 年发布的版本')).toBe(true);
    expect(isTimeSensitive('this month 的变更')).toBe(true);
  });

  it('does not flag ordinary queries', () => {
    expect(isTimeSensitive('怎么写一个 cordis 插件')).toBe(false);
    expect(isTimeSensitive('context compaction design')).toBe(false);
  });

  it('a Chinese time-sensitive query loses full coverage', () => {
    const decision = routeQuery([hit(12)], 'dsh 最新的插件 API 是什么');
    expect(decision.coverage).toBe('partial');
    expect(decision.needWeb).toBe(true);
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
