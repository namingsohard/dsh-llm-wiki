import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { WikiStore } from '../src/storage/markdown-store.js';
import { Mutator } from '../src/mutation/mutator.js';
import { evaluateAdmission, assertAdmissionScores } from '../src/mutation/admission.js';
import type { MutationOp } from '../src/types.js';

const config = resolveConfig();
let root: string;
let store: WikiStore;
let mutator: Mutator;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-wiki-mut-'));
  store = new WikiStore(root);
  await store.ensureInit();
  mutator = new Mutator(store, config);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const goodAdmission = { reusability: 3, stability: 3, novelty: 2, abstraction: 3 };

describe('admission controller', () => {
  it('accepts strong candidates', () => {
    const verdict = evaluateAdmission(goodAdmission, config);
    expect(verdict.accept).toBe(true);
  });

  it('rejects transient event logs', () => {
    const verdict = evaluateAdmission({ reusability: 0, stability: 0, novelty: 3, abstraction: 0 }, config);
    expect(verdict.accept).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('individual floor');
  });

  it('rejects weak on average despite no zero', () => {
    const verdict = evaluateAdmission({ reusability: 2, stability: 1, novelty: 2, abstraction: 1 }, config);
    expect(verdict.accept).toBe(false);
    expect(verdict.average).toBeLessThan(config.admissionMinAverage);
  });

  it('validates malformed scores', () => {
    expect(() => assertAdmissionScores({ reusability: 4, stability: 1, novelty: 1, abstraction: 1 })).toThrow(/0\.\.3/);
    expect(() => assertAdmissionScores('nope')).toThrow();
  });
});

describe('mutation engine', () => {
  it('CREATE writes an admitted page and rebuilds the index', async () => {
    const outcome = await mutator.apply([
      { op: 'create', kind: 'concept', title: 'Context Compaction', body: 'Summarizing old turns.', admission: goodAdmission, tags: ['llm'], sources: ['src-20260203-abcdef01'] },
    ]);
    expect(outcome.applied).toBe(1);
    const page = await store.read('context-compaction');
    expect(page?.revision).toBe(1);
    expect(page?.sources).toEqual(['src-20260203-abcdef01']);
    const index = await readFile(join(root, 'index.md'), 'utf8');
    expect(index).toContain('context-compaction');
  });

  it('CREATE is rejected when admission is missing or weak, and journaled', async () => {
    const noScores = await mutator.apply([{ op: 'create', title: 'X One', body: 'b' }]);
    expect(noScores.results[0]?.status).toBe('error');
    expect(noScores.results[0]?.detail).toContain('admission');

    const weak = await mutator.apply([{ op: 'create', title: 'Changelog Entry', body: 'Today we shipped v2.', admission: { reusability: 0, stability: 0, novelty: 1, abstraction: 0 } }]);
    expect(weak.results[0]?.status).toBe('rejected');
    const page = await store.read('changelog-entry');
    expect(page).toBeUndefined();
    const log = await store.recentLog(5);
    expect(log.some((e) => e.result === 'rejected')).toBe(true);
  });

  it('CREATE on an existing id points at UPDATE', async () => {
    await mutator.apply([{ op: 'create', title: 'Context Compaction', body: 'v1', admission: goodAdmission }]);
    const again = await mutator.apply([{ op: 'create', title: 'Context Compaction', body: 'v2', admission: goodAdmission }]);
    expect(again.results[0]?.status).toBe('rejected');
    expect(again.results[0]?.detail).toContain('update');
  });

  it('UPDATE replaces body and merges tags/links/sources', async () => {
    await mutator.apply([
      { op: 'create', title: 'Context Compaction', body: 'v1', admission: goodAdmission, tags: ['llm'] },
      { op: 'create', id: 'dsh', title: 'DeepSeek Harness', body: 'An agent harness.', admission: goodAdmission },
    ]);
    const upd = await mutator.apply([
      {
        op: 'update',
        id: 'context-compaction',
        body: 'v2 with implementation detail',
        tags: ['memory'],
        links: ['dsh | used by'],
        sources: ['src-20260203-abcdef01'],
      },
    ]);
    expect(upd.applied).toBe(1);
    const page = await store.read('context-compaction');
    expect(page?.body).toContain('v2 with implementation detail');
    expect(page?.revision).toBe(2);
    expect(page?.tags.sort()).toEqual(['llm', 'memory']);
    expect(page?.links).toEqual([{ target: 'dsh', relation: 'used by' }]);
  });

  it('UPDATE with no changes is a noop', async () => {
    await mutator.apply([{ op: 'create', title: 'Stable Page', body: 'same', admission: goodAdmission }]);
    const noop = await mutator.apply([{ op: 'update', id: 'stable-page', body: 'same' }]);
    expect(noop.results[0]?.status).toBe('noop');
  });

  it('MERGE redirects the weaker page and moves tags/sources', async () => {
    await mutator.apply([
      { op: 'create', id: 'prompt-caching', title: 'Prompt Caching', body: 'Cache prefixes.', admission: goodAdmission, tags: ['cost'], sources: ['src-20260203-11111111'] },
      { op: 'create', id: 'prompt-cache', title: 'Prompt Cache', body: 'Duplicated notes.', admission: goodAdmission, tags: ['latency'], sources: ['src-20260203-22222222'] },
    ]);
    const merged = await mutator.apply([{ op: 'merge', id: 'prompt-cache', into_id: 'prompt-caching', note: 'same mechanism' }]);
    expect(merged.applied).toBe(1);
    const stub = await store.read('prompt-cache');
    expect(stub?.status).toBe('merged');
    expect(stub?.supersededBy).toBe('prompt-caching');
    expect(stub?.body).toContain('prompt-caching');
    const survivor = await store.read('prompt-caching');
    expect(survivor?.tags.sort()).toEqual(['cost', 'latency']);
    expect(survivor?.sources.sort()).toEqual(['src-20260203-11111111', 'src-20260203-22222222']);
    expect(survivor?.links.some((l) => l.target === 'prompt-cache')).toBe(true);
  });

  it('LINK adds labelled relations once', async () => {
    await mutator.apply([
      { op: 'create', id: 'a', title: 'Alpha', body: 'a', admission: goodAdmission },
      { op: 'create', id: 'b', title: 'Beta', body: 'b', admission: goodAdmission },
    ]);
    const first = await mutator.apply([{ op: 'link', id: 'a', to_id: 'b', relation: 'depends on' }]);
    expect(first.applied).toBe(1);
    const second = await mutator.apply([{ op: 'link', id: 'a', to_id: 'b', relation: 'depends on' }]);
    expect(second.results[0]?.status).toBe('noop');
    const a = await store.read('a');
    expect(a?.links).toEqual([{ target: 'b', relation: 'depends on' }]);
  });

  it('LINK to a missing page fails only that op', async () => {
    await mutator.apply([{ op: 'create', id: 'a', title: 'Alpha', body: 'a', admission: goodAdmission }]);
    const outcome = await mutator.apply([
      { op: 'link', id: 'a', to_id: 'ghost' },
      { op: 'create', id: 'ok', title: 'Ok', body: 'x', admission: goodAdmission },
    ]);
    expect(outcome.results[0]?.status).toBe('error');
    expect(outcome.results[1]?.status).toBe('applied');
  });

  it('DEPRECATE keeps history and links the replacement', async () => {
    await mutator.apply([
      { op: 'create', id: 'old', title: 'Old Truth', body: 'Used to be true.', admission: goodAdmission },
      { op: 'create', id: 'new', title: 'New Truth', body: 'Now true.', admission: goodAdmission },
    ]);
    const dep = await mutator.apply([{ op: 'deprecate', id: 'old', superseded_by: 'new', reason: 'superseded in 2026' }]);
    expect(dep.applied).toBe(1);
    const page = await store.read('old');
    expect(page?.status).toBe('deprecated');
    expect(page?.supersededBy).toBe('new');
    expect(page?.body.startsWith('> **Deprecated**')).toBe(true);
  });

  it('ops run in order and one bad op does not block the rest', async () => {
    const outcome = await mutator.apply([
      { op: 'nonsense' as MutationOp['op'], id: 'x' },
      { op: 'create', id: 'fine', title: 'Fine', body: 'ok', admission: goodAdmission },
    ]);
    expect(outcome.results[0]?.status).toBe('error');
    expect(outcome.results[1]?.status).toBe('applied');
  });
});

describe('write-path graph maintenance', () => {
  it('warns about a dangling edge instead of hiding it', async () => {
    const outcome = await mutator.apply([
      { op: 'create', id: 'kuro', title: 'Kuro LOD cvars', body: 'Distance LOD and FOV.', admission: goodAdmission, links: ['wwmi-mod-workspace | related'] },
    ]);
    expect(outcome.applied).toBe(1);
    expect(outcome.graph.dangling).toEqual([{ page: 'kuro', target: 'wwmi-mod-workspace', kind: 'link', relation: 'related' }]);
    expect(outcome.graph.notes.join(' ')).toContain('does not exist');
    expect(outcome.graph.stats.dangling).toBe(1);
  });

  it('reports the scoped lint findings a later wiki_lint would report', async () => {
    await mutator.apply([{ op: 'create', id: 'lod', title: 'Context Compaction', body: 'v1', admission: goodAdmission }]);
    const outcome = await mutator.apply([
      { op: 'create', id: 'compaction', title: 'Context Compaction', body: 'v2', admission: goodAdmission },
    ]);
    expect(outcome.graph.findings.some((issue) => issue.check === 'duplicate' && issue.page === 'compaction')).toBe(true);
    expect(outcome.graph.findings.some((issue) => issue.check === 'orphan' && issue.page === 'lod')).toBe(false);
  });

  it('names a page that gained no edge, and nominates the neighbour it could link', async () => {
    await mutator.apply([
      { op: 'create', id: 'fov', title: 'FOV compensation', tags: ['rendering'], body: 'FOV changes how far the LOD distance reaches.', admission: goodAdmission },
    ]);
    const outcome = await mutator.apply([
      { op: 'create', id: 'lod', title: 'Character LOD distance', tags: ['rendering'], body: 'Distance LOD thresholds; FOV compensation changes them.', admission: goodAdmission },
    ]);
    const candidates = outcome.graph.suggestions.find((entry) => entry.id === 'lod')?.candidates ?? [];
    expect(candidates.map((candidate) => candidate.id)).toEqual(['fov']);
    expect(candidates[0]?.shared.length).toBeGreaterThan(0);
    expect(outcome.graph.notes.join(' ')).toContain('no outgoing edge');
  });

  it('strict mode refuses the write, and a batch may still create a linked cluster', async () => {
    const strict = new Mutator(store, resolveConfig({ linkTargetCheck: 'strict' }));
    const refused = await strict.apply([
      { op: 'create', id: 'a', title: 'Alpha', body: 'a', admission: goodAdmission, links: ['ghost'] },
    ]);
    expect(refused.results[0]?.status).toBe('rejected');
    expect(refused.results[0]?.detail).toContain('ghost');
    expect(await store.read('a')).toBeUndefined();

    const cluster = await strict.apply([
      { op: 'create', id: 'a', title: 'Alpha', body: 'a', admission: goodAdmission, links: ['b'] },
      { op: 'create', id: 'b', title: 'Beta', body: 'b', admission: goodAdmission, links: ['a | depends on'] },
    ]);
    expect(cluster.applied).toBe(2);
    expect(cluster.graph.dangling).toHaveLength(0);
  });

  it('strict mode also refuses an UPDATE that would add a dangling edge', async () => {
    const strict = new Mutator(store, resolveConfig({ linkTargetCheck: 'strict' }));
    await strict.apply([{ op: 'create', id: 'a', title: 'Alpha', body: 'a', admission: goodAdmission }]);
    const outcome = await strict.apply([{ op: 'update', id: 'a', links: ['ghost'] }]);
    expect(outcome.results[0]?.status).toBe('rejected');
    expect((await store.read('a'))?.links).toEqual([]);
  });

  it('off mode says nothing at all', async () => {
    const quiet = new Mutator(store, resolveConfig({ linkTargetCheck: 'off', linkSuggest: false }));
    const outcome = await quiet.apply([
      { op: 'create', id: 'kuro', title: 'Kuro LOD cvars', body: 'Distance LOD.', admission: goodAdmission, links: ['ghost'] },
    ]);
    expect(outcome.applied).toBe(1);
    expect(outcome.graph.dangling).toHaveLength(0);
    expect(outcome.graph.suggestions).toHaveLength(0);
  });

  it('previewGraph reports the same shape without touching the wiki', async () => {
    await mutator.apply([{ op: 'create', id: 'fov', title: 'FOV compensation', tags: ['rendering'], body: 'FOV and LOD distance.', admission: goodAdmission }]);
    const preview = await mutator.previewGraph([
      { op: 'create', id: 'lod', title: 'Character LOD distance', tags: ['rendering'], body: 'Distance LOD and FOV compensation.', admission: goodAdmission, links: ['ghost'] },
    ]);
    expect(preview.preview).toBe(true);
    expect(preview.dangling.map((edge) => edge.target)).toEqual(['ghost']);
    expect(preview.suggestions.find((entry) => entry.id === 'lod')?.candidates.map((row) => row.id)).toEqual(['fov']);
    expect(preview.notes.join(' ')).toContain('does not exist');
    expect(await store.read('lod')).toBeUndefined();
  });
});
