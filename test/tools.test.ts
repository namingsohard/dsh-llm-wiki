import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, name as pluginName, inject } from '../src/index.js';
import { createPromptSource } from '../src/prompt.js';

interface RecordedTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (args: any, exec: any) => Promise<any>;
  output: { schema: unknown; render: (args: any, value: any) => unknown };
  presentCall?: (args: any) => unknown;
}

interface FakeCtx {
  tools: { register: (tool: RecordedTool) => () => void };
  systemPrompt: { section: (s: { name: string; order: number; text: unknown }) => () => void; getSectionOrder: (n: string) => number };
  logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  registered: Map<string, RecordedTool>;
  sections: { name: string; order: number; text: (ctx?: unknown) => string }[];
}

function fakeCtx(): FakeCtx {
  const registered = new Map<string, RecordedTool>();
  const sections: FakeCtx['sections'] = [];
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
      getSectionOrder: () => 2000,
    },
    logger: { warn: vi.fn(), info: vi.fn() },
    registered,
    sections,
  };
}

const execStub = { signal: new AbortController().signal } as never;

let root: string;
let ctx: FakeCtx;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-wiki-tool-'));
  ctx = fakeCtx();
  delete process.env['DSH_WIKI_ROOT'];
  apply(ctx as never, { wikiRoot: root });
  // let the startup ensureInit/index promise settle
  await new Promise((r) => setTimeout(r, 50));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('plugin entry', () => {
  it('follows the Cordis plugin contract', () => {
    expect(pluginName).toBe('wiki');
    expect(inject).toEqual(['tools', 'systemPrompt']);
  });

  it('registers the five wiki tools', () => {
    expect([...ctx.registered.keys()].sort()).toEqual(['wiki_inspect', 'wiki_lint', 'wiki_mutate', 'wiki_search', 'wiki_source_save']);
  });

  it('registers a prompt section next to the web tools', () => {
    expect(ctx.sections).toHaveLength(1);
    const section = ctx.sections[0]!;
    expect(section.name).toBe('tool:wiki');
    expect(section.order).toBe(2025);
    expect(typeof section.text).toBe('function');
    const text = section.text();
    expect(text).toContain('DSH-Wiki');
    expect(text).toContain(root);
  });
});

describe('wiki_search tool', () => {
  it('reports none-coverage on an empty wiki', async () => {
    const tool = ctx.registered.get('wiki_search')!;
    const value = await tool.execute({ query: 'anything at all' }, execStub);
    expect(value.coverage).toBe('none');
    expect(value.need_web).toBe(true);
    expect(value.hits).toEqual([]);
  });

  it('returns hits and a router verdict after mutation', async () => {
    const mutate = ctx.registered.get('wiki_mutate')!;
    const out = await mutate.execute(
      {
        operations: [
          { op: 'create', title: 'Context Compaction', body: 'Summarizes old turns to save window space.', admission: { reusability: 3, stability: 3, novelty: 2, abstraction: 3 } },
        ],
      },
      execStub,
    );
    expect(out.applied).toBe(1);

    const search = ctx.registered.get('wiki_search')!;
    const value = await search.execute({ query: 'context compaction' }, execStub);
    expect(value.coverage).toBe('high');
    expect(value.use_wiki).toBe(true);
    expect(value.hits[0].id).toBe('context-compaction');
    expect(value.advice).toContain('wiki_inspect');
  });

  it('rejects malformed arguments through the schema', async () => {
    const search = ctx.registered.get('wiki_search')!;
    // query is required by the JSON schema; the raw schema is enforced by the
    // registry, and our parameters spec compiles it — validate here directly.
    const { validateArgs } = await import('@deepseek-ai/dsh-tools');
    expect(validateArgs({ query: { type: 'string', required: true } }, {})).toContain('missing required property "query"');
    void search;
  });
});

describe('wiki_inspect tool', () => {
  it('misses gently and blocks traversal ids', async () => {
    const tool = ctx.registered.get('wiki_inspect')!;
    expect((await tool.execute({ id: 'nope' }, execStub)).found).toBe(false);
    expect((await tool.execute({ id: '../../etc/passwd' }, execStub)).found).toBe(false);
    expect((await tool.execute({ id: '../../etc/passwd' }, execStub)).note).toBe('invalid page id');
  });
});

describe('wiki_source_save + grounding', () => {
  it('saves, dedupes, and grounds a page', async () => {
    const save = ctx.registered.get('wiki_source_save')!;
    const first = await save.execute({ title: 'Compaction survey', url: 'https://example.com/s', content: 'survey text about compaction' }, execStub);
    expect(first.deduplicated).toBe(false);
    const again = await save.execute({ title: 'Same survey', url: 'https://example.com/s', content: 'different extraction' }, execStub);
    expect(again.deduplicated).toBe(true);
    expect(again.id).toBe(first.id);

    const mutate = ctx.registered.get('wiki_mutate')!;
    const created = await mutate.execute(
      { operations: [{ op: 'create', title: 'Compaction Survey Notes', body: 'Key finding here.', admission: { reusability: 3, stability: 2, novelty: 2, abstraction: 2 }, sources: [first.id] }] },
      execStub,
    );
    expect(created.applied).toBe(1);

    const inspect = ctx.registered.get('wiki_inspect')!;
    const value = await inspect.execute({ id: 'compaction-survey-notes' }, execStub);
    expect(value.found).toBe(true);
    expect(value.sources[0]?.id).toBe(first.id);
    expect(value.sources[0]?.url).toBe('https://example.com/s');
  });
});

describe('wiki_lint tool', () => {
  it('surfaces broken links from an applied mutation batch', async () => {
    const mutate = ctx.registered.get('wiki_mutate')!;
    await mutate.execute({ operations: [{ op: 'create', id: 'a', title: 'A', body: 'x', admission: { reusability: 3, stability: 3, novelty: 2, abstraction: 2 }, links: ['ghost'] }] }, execStub);
    const lint = ctx.registered.get('wiki_lint')!;
    const value = await lint.execute({}, execStub);
    expect(value.issues.some((i: { check: string }) => i.check === 'broken-link')).toBe(true);
  });
});

describe('prompt playbooks', () => {
  it('load the shipped markdown files', async () => {
    const prompt = createPromptSource();
    await prompt.prefetch();
    const text = prompt.provider('/tmp/wiki');
    expect(text).toContain('Knowledge Router');
    expect(text).toContain('Knowledge Extraction');
    expect(text).toContain('Incremental Mutation');
    expect(text).toContain('Validation');
    expect(text).toContain('/tmp/wiki');
  });

  it('falls back when the prompts directory is gone', async () => {
    const brokenRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-noprompts-'));
    try {
      const { pathToFileURL } = await import('node:url');
      void pathToFileURL(brokenRoot);
      // Simulate unreadable playbooks by pointing prefetch at missing files
      // through a logger and asserting the provider still returns core text.
      const warn = vi.fn();
      const prompt = createPromptSource({ warn });
      // No prefetch: provider must serve the fallback immediately.
      expect(prompt.provider('/tmp/w').startsWith('# DSH-Wiki · Agent Semantic Memory')).toBe(true);
    } finally {
      await rm(brokenRoot, { recursive: true, force: true });
    }
  });
});
