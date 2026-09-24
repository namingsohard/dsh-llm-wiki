import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, name as pluginName, inject } from '../src/index.js';
import { createPromptSource, observeWiki, type WikiPromptStats } from '../src/prompt.js';
import { StagingQueue } from '../src/storage/staging.js';

interface RecordedTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (args: any, exec: any) => Promise<any>;
  output: { schema: unknown; render: (args: any, value: any) => unknown };
  presentCall?: (args: any) => unknown;
}

interface FakeApproval {
  request: ReturnType<typeof vi.fn>;
}

interface FakeCtx {
  tools: { register: (tool: RecordedTool) => () => void };
  systemPrompt: {
    section: (s: { name: string; order: number; text: unknown }) => () => void;
    context: (c: { name: string; order: number; text: unknown }) => () => void;
    getSectionOrder: (n: string) => number;
    getContextOrder: (n: string) => number;
  };
  get: ReturnType<typeof vi.fn>;
  logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  registered: Map<string, RecordedTool>;
  sections: { name: string; order: number; text: (ctx?: unknown) => string }[];
  contexts: { name: string; order: number; text: (ctx?: unknown) => string }[];
}

function fakeCtx(approval?: FakeApproval): FakeCtx {
  const registered = new Map<string, RecordedTool>();
  const sections: FakeCtx['sections'] = [];
  const contexts: FakeCtx['contexts'] = [];
  return {
    tools: {
      register: (tool) => {
        registered.set(tool.name, tool);
        return () => undefined;
      },
    },
    systemPrompt: {
      section: (s) => {
        sections.push(s as (typeof sections)[number]);
        return () => undefined;
      },
      context: (c) => {
        contexts.push(c as (typeof contexts)[number]);
        return () => undefined;
      },
      getSectionOrder: () => 2000,
      getContextOrder: () => 120,
    },
    // Mirrors cordis' optional service lookup: unknown names yield undefined.
    get: vi.fn((name: string) => (name === 'approval' ? approval : undefined)),
    logger: { warn: vi.fn(), info: vi.fn() },
    registered,
    sections,
    contexts,
  };
}

const execStub = { signal: new AbortController().signal } as never;
const execWithAgent = { signal: new AbortController().signal, agent: { id: 'agent-1' }, callId: 'call-1' } as never;

const GOOD_ADMISSION = { reusability: 3, stability: 3, novelty: 2, abstraction: 3 };

/** Boot one isolated plugin instance against a temp wiki root. */
async function makeWiki(config: Record<string, unknown> = {}, approval?: FakeApproval) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-tool-'));
  const ctx = fakeCtx(approval);
  delete process.env['DSH_WIKI_ROOT'];
  apply(ctx as never, { wikiRoot: root, ...config });
  // let the startup ensureInit/index promise settle
  await new Promise((r) => setTimeout(r, 50));
  return {
    root,
    ctx,
    staging: new StagingQueue(root),
    async call(name: string, args: unknown, exec: unknown = execStub) {
      return await ctx.registered.get(name)!.execute(args, exec);
    },
  };
}

type Wiki = Awaited<ReturnType<typeof makeWiki>>;

/** Today's mutation journal of one wiki root, for audit-trail assertions. */
async function journal(root: string): Promise<string> {
  const dir = join(root, 'logs');
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return '';
  }
  return (await Promise.all(names.map((name) => readFile(join(dir, name), 'utf8')))).join('\n');
}

let wiki: Wiki;

beforeEach(async () => {
  // The direct-write mode keeps these specs about behaviour, not about the gate.
  wiki = await makeWiki({ approval: 'off' });
});

afterEach(async () => {
  await rm(wiki.root, { recursive: true, force: true });
});

describe('plugin entry', () => {
  it('follows the Cordis plugin contract', () => {
    expect(pluginName).toBe('wiki');
    expect(inject).toEqual(['tools', 'systemPrompt']);
  });

  it('registers the seven wiki tools', () => {
    expect([...wiki.ctx.registered.keys()].sort()).toEqual([
      'wiki_guide',
      'wiki_inspect',
      'wiki_lint',
      'wiki_mutate',
      'wiki_review',
      'wiki_search',
      'wiki_source_save',
    ]);
  });

  it('registers a compact prompt section next to the web tools', () => {
    expect(wiki.ctx.sections).toHaveLength(1);
    const section = wiki.ctx.sections[0]!;
    expect(section.name).toBe('tool:wiki');
    expect(section.order).toBe(2025);
    expect(typeof section.text).toBe('function');
    const text = section.text();
    expect(text).toContain('DSH-Wiki');
    expect(text).toContain(wiki.root);
    // Progressive disclosure: the four playbooks stay on disk behind wiki_guide.
    expect(text).not.toContain('Knowledge Extraction');
    expect(text).toContain('wiki_guide');
    expect(text.length).toBeLessThan(1400);
  });

  it('keeps the resident section byte-stable while the wiki changes', async () => {
    const gated = await makeWiki({ approval: 'staging' });
    try {
      const before = gated.ctx.sections[0]!.text();
      await gated.call('wiki_source_save', { title: 'Survey', url: 'https://example.com/a' });
      await gated.call('wiki_mutate', {
        operations: [{ op: 'create', title: 'Staged Thing', body: 'Body.', admission: GOOD_ADMISSION, why: 'because' }],
      });
      // Any change here re-renders the leading system message and drops the
      // provider's cached prefix for the whole conversation.
      expect(gated.ctx.sections[0]!.text()).toBe(before);
    } finally {
      await rm(gated.root, { recursive: true, force: true });
    }
  });

  it('carries live state in a coarse runtime context, not in the section', async () => {
    const gated = await makeWiki({ approval: 'staging' });
    try {
      const state = gated.ctx.contexts.find((c) => c.name === 'wiki:state');
      expect(state).toBeDefined();
      expect(state!.order).toBe(130);

      await gated.call('wiki_mutate', {
        operations: [{ op: 'create', title: 'Staged Thing', body: 'Body.', admission: GOOD_ADMISSION, why: 'because' }],
      });
      const text = state!.text();
      expect(text).toContain('staging/');
      expect(text).toContain('wiki_review');
      // Counts would change on every write; buckets and a latched reminder do not.
      expect(text).not.toMatch(/\d+ proposal/);
      expect(text).not.toMatch(/\d+ page/);
    } finally {
      await rm(gated.root, { recursive: true, force: true });
    }
  });
});

describe('wiki_search tool', () => {
  it('reports none-coverage on an empty wiki', async () => {
    const value = await wiki.call('wiki_search', { query: 'anything at all' });
    expect(value.coverage).toBe('none');
    expect(value.need_web).toBe(true);
    expect(value.hits).toEqual([]);
    expect(value.next_step).toContain('web_search');
    expect(value.guide_topic).toBe('extraction');
  });

  it('returns hits and a router verdict after mutation', async () => {
    const out = await wiki.call('wiki_mutate', {
      operations: [{ op: 'create', title: 'Context Compaction', body: 'Summarizes old turns to save window space.', admission: GOOD_ADMISSION }],
    });
    expect(out.applied).toBe(1);

    const value = await wiki.call('wiki_search', { query: 'context compaction' });
    expect(value.coverage).toBe('high');
    expect(value.use_wiki).toBe(true);
    expect(value.hits[0].id).toBe('context-compaction');
    expect(value.advice).toContain('wiki_inspect');
    expect(value.next_step).toContain('wiki_inspect({ id: "context-compaction" })');
    expect(value.guide_topic).toBe('router');
  });

  it('rejects malformed arguments through the schema', async () => {
    const { validateArgs } = await import('@deepseek-ai/dsh-tools');
    expect(validateArgs({ query: { type: 'string', required: true } }, {})).toContain('missing required property "query"');
  });
});

describe('wiki_inspect tool', () => {
  it('misses gently and blocks traversal ids', async () => {
    expect((await wiki.call('wiki_inspect', { id: 'nope' })).found).toBe(false);
    expect((await wiki.call('wiki_inspect', { id: '../../etc/passwd' })).found).toBe(false);
    expect((await wiki.call('wiki_inspect', { id: '../../etc/passwd' })).note).toBe('invalid page id');
  });
});

describe('wiki_source_save + grounding', () => {
  it('records a link-only card, dedupes by url, and grounds a page', async () => {
    const first = await wiki.call('wiki_source_save', { title: 'Compaction survey', url: 'https://example.com/s' });
    expect(first.deduplicated).toBe(false);
    expect(first.staged).toBe(false);

    const card = await wiki.call('wiki_inspect', { id: first.id });
    expect(card.found).toBe(true);
    expect(card.page.body).toContain('https://example.com/s');
    expect(card.page.body).toContain('not stored here');
    // The whole point of the card format: provenance costs a few hundred bytes.
    expect(first.bytes).toBeLessThan(400);
    expect(Buffer.byteLength(card.page.body, 'utf8')).toBeLessThan(400);

    const again = await wiki.call('wiki_source_save', { title: 'Same survey, later day', url: 'https://example.com/s' });
    expect(again.deduplicated).toBe(true);
    expect(again.id).toBe(first.id);

    const created = await wiki.call('wiki_mutate', {
      operations: [{ op: 'create', title: 'Compaction Survey Notes', body: 'Key finding here.', admission: { reusability: 3, stability: 2, novelty: 2, abstraction: 2 }, sources: [first.id] }],
    });
    expect(created.applied).toBe(1);

    const value = await wiki.call('wiki_inspect', { id: 'compaction-survey-notes' });
    expect(value.found).toBe(true);
    expect(value.sources[0]?.id).toBe(first.id);
    expect(value.sources[0]?.url).toBe('https://example.com/s');
  });

  it('still cards material that has no url', async () => {
    const saved = await wiki.call('wiki_source_save', { title: 'Bob (slack, 2026-02-10)' });
    expect(saved.deduplicated).toBe(false);
    const card = await wiki.call('wiki_inspect', { id: saved.id });
    expect(card.found).toBe(true);
    expect(card.page.body).toContain('Bob (slack, 2026-02-10)');
  });
});

describe('wiki_lint tool', () => {
  it('surfaces broken links from an applied mutation batch', async () => {
    await wiki.call('wiki_mutate', {
      operations: [{ op: 'create', id: 'a', title: 'A', body: 'x', admission: GOOD_ADMISSION, links: ['ghost'] }],
    });
    const value = await wiki.call('wiki_lint', {});
    expect(value.issues.some((i: { check: string }) => i.check === 'broken-link')).toBe(true);
  });
});

describe('wiki_guide', () => {
  it('serves each playbook verbatim on demand', async () => {
    const router = await wiki.call('wiki_guide', { topic: 'router' });
    expect(router.found).toBe(true);
    expect(router.playbook).toContain('Knowledge Router');
    expect(router.topics).toEqual(['router', 'extraction', 'mutation', 'validation']);
    for (const [topic, marker] of [['extraction', 'Knowledge Extraction'], ['mutation', 'Incremental Mutation'], ['validation', 'Validation & Hygiene']] as const) {
      expect((await wiki.call('wiki_guide', { topic })).playbook).toContain(marker);
    }
  });
});

describe('write gate: staging', () => {
  let gated: Wiki;
  let granted: FakeApproval;

  beforeEach(async () => {
    granted = { request: vi.fn(async () => 'allowed-once') };
    gated = await makeWiki({ approval: 'staging' }, granted);
  });

  afterEach(async () => {
    await rm(gated.root, { recursive: true, force: true });
  });

  const propose = async () => {
    const saved = await gated.call('wiki_source_save', { title: 'Survey', url: 'https://example.com/a', why: 'grounding for the page below' });
    const mut = await gated.call('wiki_mutate', {
      operations: [{ op: 'create', title: 'Compaction Basics', body: 'Compaction summarizes older turns.', admission: GOOD_ADMISSION, sources: [saved.id], why: 'reusable mechanism' }],
    });
    return { saved, mut };
  };

  it('parks writes in staging/ and leaves the live wiki untouched', async () => {
    const { saved, mut } = await propose();
    expect(saved.staged).toBe(true);
    expect(saved.staged_as).toMatch(/^src-[0-9a-f]{8}$/);
    expect(mut.staged).toBe(1);
    expect(mut.applied).toBe(0);
    expect(mut.results[0]!.status).toBe('staged');
    expect(mut.pending_total).toBe(2);
    expect(mut.note).toContain('wiki_review');

    const search = await gated.call('wiki_search', { query: 'compaction basics' });
    expect(search.hits).toHaveLength(0);
    expect(search.coverage).toBe('none');
    const lint = await gated.call('wiki_lint', {});
    expect(lint.scanned).toBe(0);
    expect((await gated.staging.list()).entries).toHaveLength(2);
  });

  it('re-proposing the same thing replaces the pending entry instead of piling up', async () => {
    await propose();
    await gated.call('wiki_source_save', { title: 'Survey edited', url: 'https://example.com/a' });
    expect((await gated.staging.list()).entries).toHaveLength(2);
  });

  it('rejects weak candidates at stage time, before the user is bothered', async () => {
    const out = await gated.call('wiki_mutate', {
      operations: [
        { op: 'create', title: 'Standup chatter', body: 'Bob fixed the build.', admission: { reusability: 0, stability: 0, novelty: 1, abstraction: 0 } },
        { op: 'create', title: 'No scores', body: 'x' },
      ],
    });
    expect(out.rejected).toBe(2);
    expect(out.staged).toBe(0);
    expect(out.results[0]!.detail).toContain('admission rejected');
    expect(out.results[1]!.detail).toContain('requires admission scores');
    expect((await gated.staging.list()).entries).toHaveLength(0);
    expect(granted.request).not.toHaveBeenCalled();
  });

  it('list shows the proposals with their reasons and asks nobody', async () => {
    await propose();
    const listed = await gated.call('wiki_review', { action: 'list' });
    expect(listed.pending).toHaveLength(2);
    expect(listed.pending.map((row: { op: string }) => row.op)).toEqual(['source_save', 'create']);
    expect(listed.pending[1]!.reason).toBe('reusable mechanism');
    expect(listed.pending[1]!.pitch).toContain('Compaction Basics');
    expect(granted.request).not.toHaveBeenCalled();
  });

  it('promote asks once, then the knowledge is searchable and grounded', async () => {
    await propose();
    const promoted = await gated.call('wiki_review', {}, execWithAgent);
    expect(granted.request).toHaveBeenCalledTimes(1);
    const reason = granted.request.mock.calls[0]![0].reason as string;
    expect(reason).toContain('Compaction Basics');
    expect(reason).toContain('why: reusable mechanism');
    // The approval card renders `reason` in a plain div: newlines collapse and
    // markdown never renders, so the pitch must read as one line.
    expect(reason).not.toContain('\n');
    expect(reason).toContain('①');
    expect(reason).toContain('②');
    expect(reason).toContain('Allow once writes all of them');

    expect(promoted.applied).toBe(2);
    expect(promoted.pending_total).toBe(0);
    expect((await gated.staging.list()).entries).toHaveLength(0);

    const search = await gated.call('wiki_search', { query: 'compaction basics' });
    expect(search.coverage).toBe('high');
    expect(search.hits[0]!.id).toBe('compaction-basics');
    const inspected = await gated.call('wiki_inspect', { id: 'compaction-basics' });
    expect(inspected.sources[0]!.url).toBe('https://example.com/a');
  });

  it('a targeted id list only promotes what the user picked', async () => {
    const { saved } = await propose();
    const promoted = await gated.call('wiki_review', { ids: [saved.staged_as] }, execWithAgent);
    expect(promoted.promoted).toBe(1);
    expect(promoted.applied).toBe(1);
    expect(promoted.pending_total).toBe(1);
    const still = await gated.call('wiki_review', { action: 'list' });
    expect(still.pending[0]!.op).toBe('create');
  });

  it('a refusal discards the proposals it covered — the user said this is not wiki material', async () => {
    granted.request.mockImplementation(async () => 'rejected');
    await propose();
    const promoted = await gated.call('wiki_review', {}, execWithAgent);
    expect(promoted.applied).toBe(0);
    expect(promoted.promoted).toBe(0);
    expect(promoted.discarded).toBe(2);
    expect(promoted.pending_total).toBe(0);
    expect(promoted.note).toContain('declined');
    expect(promoted.note).toContain('discarded 2 proposal(s) from staging/');
    expect((await gated.staging.list()).entries).toHaveLength(0);
    // Journaled, so the audit trail records a decision rather than silence.
    expect(await journal(gated.root)).toContain('declined by the user: 2 proposal(s) discarded from staging/');
  });

  it('a cancelled prompt discards too, so an abandoned turn leaves no queue behind', async () => {
    granted.request.mockImplementation(async () => 'cancelled');
    await propose();
    const promoted = await gated.call('wiki_review', {}, execWithAgent);
    expect(promoted.discarded).toBe(2);
    expect((await gated.staging.list()).entries).toHaveLength(0);
  });

  it('a refusal drops only what it covered — proposals nobody was shown survive', async () => {
    const { saved } = await propose();
    granted.request.mockImplementation(async () => 'rejected');
    const refused = await gated.call('wiki_review', { ids: [saved.staged_as] }, execWithAgent);
    expect(refused.discarded).toBe(1);
    expect(refused.pending_total).toBe(1);
    const still = await gated.call('wiki_review', { action: 'list' });
    expect(still.pending[0]!.op).toBe('create');
  });

  it('fails closed when no approval channel is composed', async () => {
    const headless = await makeWiki({ approval: 'staging' });
    try {
      await headless.call('wiki_mutate', { operations: [{ op: 'create', title: 'X', body: 'y', admission: GOOD_ADMISSION }] });
      const promoted = await headless.call('wiki_review', {}, execWithAgent);
      expect(promoted.applied).toBe(0);
      expect(promoted.discarded).toBe(0);
      expect(promoted.note).toContain('no approval channel');
      expect((await headless.staging.list()).entries).toHaveLength(1);
    } finally {
      await rm(headless.root, { recursive: true, force: true });
    }
  });

  it('discard drops proposals without asking', async () => {
    await propose();
    const dropped = await gated.call('wiki_review', { action: 'discard' });
    expect(dropped.discarded).toBe(2);
    expect(granted.request).not.toHaveBeenCalled();
    expect((await gated.staging.list()).entries).toHaveLength(0);
  });

  it('reports ids that are not pending', async () => {
    const out = await gated.call('wiki_review', { ids: ['pg-doesnotexist'], action: 'list' });
    expect(out.unknown_ids).toEqual(['pg-doesnotexist']);
    expect(out.pending).toHaveLength(0);
  });
});

describe('write gate: inline', () => {
  it('asks at call time and only writes on a grant', async () => {
    const granted: FakeApproval = { request: vi.fn(async () => 'allowed-once') };
    const inline = await makeWiki({ approval: 'inline' }, granted);
    try {
      const saved = await inline.call('wiki_source_save', { title: 'T', url: 'https://example.com/i' }, execWithAgent);
      expect(saved.staged).toBe(false);
      expect(saved.deduplicated).toBe(false);
      expect(granted.request).toHaveBeenCalledTimes(1);
      expect((granted.request.mock.calls[0]![0].reason as string)).toContain('https://example.com/i');
      expect((granted.request.mock.calls[0]![0].reason as string)).toContain('link only');
      const search = await inline.call('wiki_search', { query: 'nothing here' });
      expect(search.total_pages).toBe(1);

      const refused = { request: vi.fn(async () => 'rejected') };
      const denying = await makeWiki({ approval: 'inline' }, refused);
      try {
        const out = await denying.call('wiki_mutate', { operations: [{ op: 'create', title: 'Never Landed', body: 'x', admission: GOOD_ADMISSION }] }, execWithAgent);
        expect(out.applied).toBe(0);
        expect(out.rejected).toBe(1);
        expect(out.results[0]!.detail).toContain('declined');
        expect((await denying.staging.list()).entries).toHaveLength(0);
      } finally {
        await rm(denying.root, { recursive: true, force: true });
      }
    } finally {
      await rm(inline.root, { recursive: true, force: true });
    }
  });
});

describe('prompt playbooks', () => {
  it('stay out of the resident prompt and come from disk on demand', async () => {
    const prompt = createPromptSource();
    await prompt.prefetch();
    const text = prompt.provider('/tmp/wiki');
    expect(text).toContain('DSH-Wiki');
    expect(text).toContain('/tmp/wiki');
    expect(text).toContain('runtime-context snapshot');
    expect(text).not.toContain('Knowledge Router');

    const { readPlaybook } = await import('../src/prompt.js');
    expect(await readPlaybook('router')).toContain('Knowledge Router');
    expect(await readPlaybook('mutation')).toContain('Incremental Mutation');
  });

  it('renders coarse latched state instead of live counters', () => {
    const stats: WikiPromptStats = { pages: 0, pending: 0 };
    const prompt = createPromptSource(undefined, stats);
    // Nothing has been read from disk yet: say nothing rather than "empty".
    expect(prompt.stateProvider()).toBe('');

    observeWiki(stats, 0, 0);
    expect(prompt.stateProvider()).toContain('Wiki state: empty');

    observeWiki(stats, 12, 0);
    expect(prompt.stateProvider()).toContain('a working set of pages (10-49)');

    observeWiki(stats, 12, 4);
    const busy = prompt.stateProvider();
    expect(busy).toContain('staging/');
    expect(busy).not.toMatch(/\d+ proposal/);

    // Both latches: a shrinking wiki or an emptied queue must not re-render.
    observeWiki(stats, 1, 0);
    expect(prompt.stateProvider()).toBe(busy);
  });
});
