import { describe, expect, it } from 'vitest';
import { extractWikiLinks, WikiGraph, type GraphOptions } from '../src/graph/graph.js';
import { suggestNeighbors } from '../src/graph/suggest.js';
import type { PageKind, PageStatus, WikiPage } from '../src/types.js';

const OFF: GraphOptions = { wikiLinkEdges: false, sourceEdges: false };
const ON: GraphOptions = { wikiLinkEdges: true, sourceEdges: true };

function page(overrides: Partial<WikiPage> & { id: string }): WikiPage {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    kind: (overrides.kind ?? 'concept') as PageKind,
    title: overrides.title ?? overrides.id,
    status: (overrides.status ?? 'active') as PageStatus,
    revision: 1,
    created: now,
    updated: now,
    tags: overrides.tags ?? [],
    links: overrides.links ?? [],
    sources: overrides.sources ?? [],
    body: overrides.body ?? 'text\n',
    path: '',
  };
}

describe('derived graph', () => {
  it('sees declared edges in both directions', () => {
    const graph = WikiGraph.fromPages([
      page({ id: 'earth', links: [{ target: 'eight-planets', relation: 'related' }] }),
      page({ id: 'eight-planets' }),
    ], OFF);
    expect(graph.outgoing('earth', ['link'])).toEqual([{ from: 'earth', to: 'eight-planets', kind: 'link', relation: 'related' }]);
    expect(graph.incoming('eight-planets', ['link']).map((edge) => edge.from)).toEqual(['earth']);
    expect(graph.neighbors('eight-planets').map((row) => row.id)).toEqual(['earth']);
    expect(graph.neighbors('earth').map((row) => row.relation)).toEqual(['related']);
  });

  it('names a declared edge whose target does not exist, but never a provenance ref', () => {
    const graph = WikiGraph.fromPages([page({ id: 'kuro', links: [{ target: 'wwmi-mod-workspace' }], sources: ['src-gone'] })], ON);
    expect(graph.danglingEdges()).toEqual([{ page: 'kuro', target: 'wwmi-mod-workspace', kind: 'link' }]);
    expect(graph.danglingOf('kuro').some((edge) => edge.target === 'src-gone')).toBe(false);
  });

  it('derives [[id]] edges only when that family is enabled', () => {
    const pages = [page({ id: 'old', status: 'merged', body: '> Merged into **[[new]] (New)**.\n' }), page({ id: 'new' })];
    expect(WikiGraph.fromPages(pages, OFF).outgoing('old', ['wikilink'])).toHaveLength(0);
    const graph = WikiGraph.fromPages(pages, ON);
    expect(graph.outgoing('old', ['wikilink']).map((edge) => edge.to)).toEqual(['new']);
    expect(graph.knowledgeOutbound('old')).toBe(1);
  });

  it('does not mistake code for a mention, a duplicate edge, or a self-mention', () => {
    const body = ['See [[new]] once.', 'Inline `[[new]]` is an example.', '```', 'fenced [[new]]', '```', '[[new]] again.', '[[old]] is this page.'].join('\n');
    const graph = WikiGraph.fromPages([page({ id: 'old', body }), page({ id: 'new' })], ON);
    expect(extractWikiLinks(body, 'old')).toEqual(['new']);
    expect(graph.outgoing('old').filter((edge) => edge.to === 'new')).toHaveLength(1);
  });

  it('counts provenance consumers of a source card', () => {
    const graph = WikiGraph.fromPages([
      page({ id: 'fact', sources: ['src-20261004-aaaaaa11'] }),
      page({ id: 'also', sources: ['src-20261004-aaaaaa11'] }),
      page({ id: 'src-20261004-aaaaaa11', kind: 'source', title: 'A guide' }),
    ], ON);
    expect(graph.referencedBy('src-20261004-aaaaaa11')).toEqual(['also', 'fact']);
    expect(graph.referencedBy('fact')).toEqual([]);
  });

  it('reports the shape a wiki is in', () => {
    const graph = WikiGraph.fromPages([
      page({ id: 'a', links: [{ target: 'b' }] }),
      page({ id: 'b' }),
      page({ id: 'c' }),
      page({ id: 'dangling', links: [{ target: 'nobody' }] }),
    ], OFF);
    const stats = graph.stats();
    // `a` and `dangling` each have an out-edge (one of them broken); only b and c
    // reach nothing, which is what `isolated` means.
    expect(stats).toMatchObject({ pages: 4, edges: 2, dangling: 1, orphans: 3, isolated: 2 });
    expect(stats.byKind).toEqual({ link: 2, wikilink: 0, source: 0 });
  });
});

describe('neighbor nomination', () => {
  const options = { limit: 5, minScore: 2, agingAfterDays: 90, staleAfterDays: 365 };

  it('nominates the page it shares terms with and quotes the evidence', () => {
    const graph = WikiGraph.fromPages([
      page({ id: 'lod', title: 'Character LOD distance cvars', tags: ['rendering'], body: 'Distance LOD is compensated by FOV cvars.' }),
      page({ id: 'fov', title: 'FOV compensation', tags: ['rendering'], body: 'FOV changes how far LOD distance reaches.' }),
      page({ id: 'kubernetes', title: 'Kubernetes operators', tags: ['devops'], body: 'Reconcile loops and CRDs.' }),
    ], OFF);
    const subject = graph.get('lod') as WikiPage;
    const hits = suggestNeighbors(graph, { id: subject.id, title: subject.title, tags: subject.tags, body: subject.body }, options);
    expect(hits.map((hit) => hit.id)).toEqual(['fov']);
    expect(hits[0]?.shared.length).toBeGreaterThan(0);
  });

  it('never nominates what is already linked, archived, or a source card', () => {
    const graph = WikiGraph.fromPages([
      page({ id: 'lod', title: 'Character LOD distance', links: [{ target: 'fov' }], body: 'Distance LOD and FOV.' }),
      page({ id: 'fov', title: 'FOV distance' }),
      page({ id: 'archived', title: 'LOD distance notes', status: 'deprecated' }),
      page({ id: 'src-20261004-bbbbbb22', kind: 'source', title: 'LOD distance guide' }),
    ], ON);
    const subject = graph.get('lod') as WikiPage;
    const hits = suggestNeighbors(graph, { id: subject.id, title: subject.title, tags: subject.tags, body: subject.body }, options);
    expect(hits.map((hit) => hit.id)).toEqual([]);
  });

  it('respects the score floor and the limit', () => {
    const graph = WikiGraph.fromPages([
      page({ id: 'lod', title: 'Character LOD distance', body: 'Distance LOD thresholds for distant characters.' }),
      page({ id: 'close', title: 'Near clip plane', body: 'Distance LOD distance distance distance.' }),
      page({ id: 'unrelated', title: 'Sourdough starter', body: 'Feed it weekly.' }),
    ], OFF);
    const subject = graph.get('lod') as WikiPage;
    const loose = suggestNeighbors(graph, { id: subject.id, title: subject.title, tags: subject.tags, body: subject.body }, { ...options, minScore: 0 });
    expect(loose.map((hit) => hit.id)).toContain('close');
    expect(suggestNeighbors(graph, { id: subject.id, title: subject.title, tags: subject.tags, body: subject.body }, { ...options, limit: 0 })).toHaveLength(0);
  });
});
