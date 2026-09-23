// Smoke test for the BUILT artifact: loads lib/index.js with plain Node (no
// bundler), drives the full knowledge loop against a temporary wiki root:
// source save -> admission-gated create -> wiki-first search verdict ->
// inspect -> lint. Run with `pnpm smoke` after `pnpm build`.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const { name, inject, Config, apply } = await import('../lib/index.js');

assert.equal(name, 'wiki');
assert.deepEqual(inject, ['tools', 'systemPrompt']);
assert.ok(Config, 'Config schema exported');

const registered = new Map();
const sections = [];
const ctx = {
  tools: { register: (tool) => (registered.set(tool.name, tool), () => undefined) },
  systemPrompt: {
    section: (s) => (sections.push(s), () => undefined),
    getSectionOrder: () => 2000,
  },
  logger: { warn: (...a) => console.warn('[warn]', ...a), info: () => undefined },
};

const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-smoke-'));
delete process.env.DSH_WIKI_ROOT;
apply(ctx, { wikiRoot: root });
await new Promise((r) => setTimeout(r, 100));

assert.deepEqual(
  [...registered.keys()].sort(),
  ['wiki_inspect', 'wiki_lint', 'wiki_mutate', 'wiki_search', 'wiki_source_save'],
);
assert.equal(sections.length, 1);
assert.equal(sections[0].name, 'tool:wiki');
assert.ok(sections[0].text().includes('DSH-Wiki'));

const exec = { signal: new AbortController().signal };
const call = async (tool, args) => await registered.get(tool).execute(args, exec);

// 1. empty wiki => router says acquire
const empty = await call('wiki_search', { query: 'context compaction strategies' });
assert.equal(empty.coverage, 'none');
assert.equal(empty.need_web, true);

// 2. persist a source, then create a grounded concept
const saved = await call('wiki_source_save', {
  title: 'Anthropic — Effective context engineering for AI agents',
  url: 'https://example.com/ctx',
  content: 'Compaction summarizes the conversation history when the context window fills.',
});
assert.equal(saved.deduplicated, false);

const mutated = await call('wiki_mutate', {
  operations: [
    {
      op: 'create',
      kind: 'concept',
      title: 'Context Compaction',
      body: 'Compaction summarizes older turns so long tasks fit the context window. Apply near the threshold, keep artifacts, re-inject summaries.',
      tags: ['llm', 'context'],
      sources: [saved.id],
      links: ['dsh | used in'],
      admission: { reusability: 3, stability: 3, novelty: 2, abstraction: 3 },
      note: 'learned from context-engineering article',
    },
    {
      op: 'create',
      kind: 'concept',
      title: 'Today in standup',
      body: 'Bob mentioned the build broke at 9am.',
      admission: { reusability: 0, stability: 0, novelty: 1, abstraction: 0 },
    },
  ],
});
assert.equal(mutated.applied, 1, 'the transient event must fail admission');
assert.equal(mutated.results[1].status, 'rejected');

// 3. wiki-first now returns high coverage
const found = await call('wiki_search', { query: 'context compaction' });
assert.equal(found.coverage, 'high');
assert.equal(found.use_wiki, true);
assert.equal(found.hits[0].id, 'context-compaction');

// 4. inspect resolves grounding
const inspected = await call('wiki_inspect', { id: 'context-compaction' });
assert.equal(inspected.found, true);
assert.equal(inspected.sources[0].url, 'https://example.com/ctx');

// 5. lint sees the dangling link and stays report-only
const lint = await call('wiki_lint', {});
assert.ok(lint.issues.some((i) => i.check === 'broken-link' && i.page === 'context-compaction'));

await rm(root, { recursive: true, force: true });
console.log('dsh-llm-wiki smoke: OK — full knowledge loop works on the built artifact');
