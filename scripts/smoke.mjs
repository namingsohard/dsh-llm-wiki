// Smoke test for the BUILT artifact: loads lib/index.js with plain Node (no
// bundler) and drives the knowledge loop against a temporary wiki root.
// Pass 1 runs the default write gate end to end: proposal -> staging -> user
// approval through the harness seam -> live, searchable, grounded knowledge.
// Pass 2 re-runs the loop with approval: "off" (direct writes) and checks the
// link-only source card. Pass 3 simulates the agent loop around the web-access
// nudge; pass 4 checks that `nudge: off` registers nothing.
// Run with `pnpm smoke` after `pnpm build`.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const { name, inject, Config, apply } = await import('../lib/index.js');

assert.equal(name, 'wiki');
assert.deepEqual(inject, ['tools', 'systemPrompt']);
assert.ok(Config, 'Config schema exported');

const SEVEN = ['wiki_guide', 'wiki_inspect', 'wiki_lint', 'wiki_mutate', 'wiki_review', 'wiki_search', 'wiki_source_save'];

function makeCtx(approvalOutcome) {
  const registered = new Map();
  const sections = [];
  const contexts = [];
  const asked = [];
  const handlers = new Map();
  const ctx = {
    tools: { register: (tool) => (registered.set(tool.name, tool), () => undefined) },
    systemPrompt: {
      section: (s) => (sections.push(s), () => undefined),
      context: (c) => (contexts.push(c), () => undefined),
      getSectionOrder: () => 2000,
      getContextOrder: () => 120,
    },
    // Harness event seams (agent loop + tool pipeline), as cordis exposes them.
    on: (event, handler) => (handlers.set(event, handler), () => handlers.delete(event)),
    // cordis' optional service lookup: the plugin asks for 'approval' and copes
    // with a deployment that composes none.
    get: (serviceName) => (serviceName === 'approval' && approvalOutcome !== undefined
      ? { request: async (req) => (asked.push(req), approvalOutcome) }
      : undefined),
    logger: { warn: (...a) => console.warn('[warn]', ...a), info: () => undefined },
  };
  return { ctx, registered, sections, contexts, asked, handlers };
}

async function boot(config, approvalOutcome) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-smoke-'));
  const host = makeCtx(approvalOutcome);
  delete process.env.DSH_WIKI_ROOT;
  apply(host.ctx, { wikiRoot: root, ...config });
  await new Promise((r) => setTimeout(r, 100));
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' }, callId: 'call-1' };
  return {
    root,
    ...host,
    exec,
    call: async (tool, args, at = exec) => await host.registered.get(tool).execute(args, at),
  };
}

const GOOD = { reusability: 3, stability: 3, novelty: 2, abstraction: 3 };

// ---------------------------------------------------------------- pass 1: gate
{
  const wiki = await boot({}, 'allowed-once');
  try {
    assert.deepEqual([...wiki.registered.keys()].sort(), SEVEN);
    assert.equal(wiki.sections.length, 1);
    assert.equal(wiki.sections[0].name, 'tool:wiki');
    const prompt = wiki.sections[0].text();
    assert.ok(prompt.includes('DSH-Wiki') && prompt.includes('wiki_guide'));
    assert.ok(prompt.length < 1400, `resident prompt should stay small, got ${prompt.length} chars`);
    assert.ok(!prompt.includes('Knowledge Extraction'), 'playbooks must not be inlined');

    // Live state rides in the runtime-context snapshot: an append on change,
    // never a rewrite of the cached system-prompt prefix.
    assert.equal(wiki.contexts.length, 1);
    assert.equal(wiki.contexts[0].name, 'wiki:state');
    assert.ok(wiki.contexts[0].text().startsWith('Wiki state: empty'), 'a fresh wiki reports itself empty');

    const empty = await wiki.call('wiki_search', { query: 'context compaction strategies' });
    assert.equal(empty.coverage, 'none');
    assert.equal(empty.need_web, true);
    assert.ok(empty.next_step.includes('web_search'), 'verdict must name the next call');
    assert.equal(empty.guide_topic, 'extraction');

    const saved = await wiki.call('wiki_source_save', {
      title: 'Anthropic — Effective context engineering for AI agents',
      url: 'https://example.com/ctx',
      why: 'the mechanism behind DSH compaction; reused by any long-session task',
    });
    assert.equal(saved.staged, true, 'a gated source save must not write live');
    assert.match(saved.staged_as, /^src-[0-9a-f]{8}$/);

    const mutated = await wiki.call('wiki_mutate', {
      operations: [
        {
          op: 'create',
          kind: 'concept',
          title: 'Context Compaction',
          body: 'Compaction summarizes older turns so long tasks fit the context window. Apply near the threshold, keep artifacts, re-inject summaries.',
          tags: ['llm', 'context'],
          sources: [saved.id],
          links: ['dsh | used in'],
          admission: GOOD,
          why: 'reusable mechanism, stable across releases, learned from a primary source',
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
    assert.equal(mutated.staged, 1, 'the admitted op is held');
    assert.equal(mutated.applied, 0, 'nothing is live before approval');
    assert.equal(mutated.results[1].status, 'rejected', 'the transient event fails admission at stage time');
    assert.equal(mutated.pending_total, 2);

    const before = await wiki.call('wiki_search', { query: 'context compaction' });
    assert.equal(before.hits.length, 0, 'staged proposals stay invisible to retrieval');

    const listed = await wiki.call('wiki_review', { action: 'list' });
    assert.equal(listed.pending.length, 2);
    assert.equal(listed.pending[1].reason, 'reusable mechanism, stable across releases, learned from a primary source');
    assert.equal(wiki.asked.length, 0, 'listing must not prompt the user');

    const promoted = await wiki.call('wiki_review', {});
    assert.equal(wiki.asked.length, 1, 'one auditable ask per review');
    assert.ok(wiki.asked[0].reason.includes('Context Compaction'), 'the ask must carry the pitch');
    // The approval card renders `reason` as plain text in one div: newlines
    // collapse, so the items have to be separable some other way.
    assert.ok(!wiki.asked[0].reason.includes('\n'), 'the pitch must be a single line');
    assert.ok(wiki.asked[0].reason.includes('①'), 'items need markers that survive the collapse');
    assert.equal(wiki.sections[0].text(), prompt, 'the resident section must not change mid-session');
    const state = wiki.contexts[0].text();
    assert.ok(!/\d+ (page|proposal)/.test(state), 'the snapshot stays coarse: buckets, not counters');
    assert.ok(state.includes('staging/'), 'the staging reminder stays latched after the promote');
    assert.equal(promoted.applied, 2);
    assert.equal(promoted.pending_total, 0);

    const found = await wiki.call('wiki_search', { query: 'context compaction' });
    assert.equal(found.coverage, 'high');
    assert.equal(found.hits[0].id, 'context-compaction');
    assert.ok(found.next_step.includes('wiki_inspect({ id: "context-compaction" })'));

    const inspected = await wiki.call('wiki_inspect', { id: 'context-compaction' });
    assert.equal(inspected.found, true);
    assert.equal(inspected.sources[0].url, 'https://example.com/ctx');

    const lint = await wiki.call('wiki_lint', {});
    assert.ok(lint.issues.some((i) => i.check === 'broken-link' && i.page === 'context-compaction'));

    const guide = await wiki.call('wiki_guide', { topic: 'mutation' });
    assert.equal(guide.found, true);
    assert.ok(guide.playbook.includes('Incremental Mutation'));

    // A refusal is a verdict on the content: the declined batch is dropped, not parked.
    const stubborn = await boot({}, 'rejected');
    try {
      await stubborn.call('wiki_mutate', { operations: [{ op: 'create', title: 'Held Back', body: 'x', admission: GOOD }] });
      const refused = await stubborn.call('wiki_review', {});
      assert.equal(refused.applied, 0);
      assert.equal(refused.discarded, 1);
      assert.ok(refused.note.includes('declined'));
      const afterRefusal = await stubborn.call('wiki_review', { action: 'list' });
      assert.equal(afterRefusal.pending_total, 0, 'a declined batch is discarded, not left to pile up');
      const stillEmpty = await stubborn.call('wiki_search', { query: 'held back' });
      assert.equal(stillEmpty.hits.length, 0);
    } finally {
      await rm(stubborn.root, { recursive: true, force: true });
    }

    // No approval channel composed: gated writes fail closed, they never sneak through.
    // And nobody having seen the proposal is not a decision, so it survives.
    const headless = await boot({}, undefined);
    try {
      await headless.call('wiki_mutate', { operations: [{ op: 'create', title: 'Orphan Proposal', body: 'x', admission: GOOD }] });
      const blocked = await headless.call('wiki_review', {});
      assert.equal(blocked.applied, 0);
      assert.equal(blocked.discarded, 0);
      assert.ok(blocked.note.includes('no approval channel'), blocked.note);
      assert.equal((await headless.call('wiki_review', { action: 'list' })).pending_total, 1);
    } finally {
      await rm(headless.root, { recursive: true, force: true });
    }
  } finally {
    await rm(wiki.root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------- pass 2: approval "off"
{
  const wiki = await boot({ approval: 'off' }, undefined);
  try {
    const saved = await wiki.call('wiki_source_save', { title: 'Direct save', url: 'https://example.com/d' });
    assert.equal(saved.staged, false);
    assert.ok(saved.bytes < 400, `a source card must stay tiny, got ${saved.bytes} bytes`);
    const card = await wiki.call('wiki_inspect', { id: saved.id });
    assert.ok(card.page.body.includes('https://example.com/d'), 'the card must keep the link');
    assert.ok(card.page.body.includes('not stored here'), 'the card must say it stores no text');
    const mutated = await wiki.call('wiki_mutate', { operations: [{ op: 'create', title: 'Direct Page', body: 'Body.', admission: GOOD, sources: [saved.id] }] });
    assert.equal(mutated.applied, 1);
    const found = await wiki.call('wiki_search', { query: 'direct page' });
    assert.equal(found.coverage, 'high');
    const review = await wiki.call('wiki_review', { action: 'list' });
    assert.equal(review.pending_total, 0, 'nothing queues when the gate is off');
  } finally {
    await rm(wiki.root, { recursive: true, force: true });
  }
}

// ------------------------------------------------- pass 3: next-step nudge
{
  const wiki = await boot({ approval: 'off' }, undefined);
  try {
    assert.deepEqual(
      [...wiki.handlers.keys()].sort(),
      ['agent/pre-step', 'subagent/start', 'tools/result'],
      'the nudge observes the step boundary and the settled tool outcome, never the turn boundary',
    );
    const preStep = wiki.handlers.get('agent/pre-step');
    // `tools/result` is an emit over the frozen outcome: no `next`, no decision.
    const result = wiki.handlers.get('tools/result');
    const agent = { id: 'researcher' };
    // One and the same decision object is handed in every time: the fold must
    // never mutate it, and a broken implementation would grow this batch.
    const enter = { kind: 'enter', messages: [] };

    // quiet turn: reads only → no reminder folded in
    await preStep({ agent, turn: 1 }, async () => enter);
    assert.equal(result({ agent, name: 'read' }, { content: [] }), undefined, 'observation returns nothing');
    let decision = await preStep({ agent, turn: 1 }, async () => enter);
    assert.equal(decision.messages.length, 0, 'a turn that never searched the web gets no reminder');

    // research turn that skipped the wiki: one reminder on the NEXT step, turn not extended
    result({ agent, name: 'web_search' }, { content: [] });
    result({ agent, name: 'web_fetch' }, { content: [] });
    decision = await preStep({ agent, turn: 1 }, async () => enter);
    assert.equal(decision.messages.length, 1, 'one reminder folded into the next step');
    assert.match(decision.messages[0].content[0].text, /2 web call\(s\)/, 'the reminder counts the web calls');
    assert.match(decision.messages[0].content[0].text, /wiki_search/, 'the reminder names the call to make');
    assert.equal(decision.messages[0].role, 'user');
    // Session format v4 (dsh 0.1.7+) refuses `kind: 'plugin'` on the append path.
    assert.equal(decision.messages[0].source.kind, 'plugin:dsh-llm-wiki', 'the reminder is producer-sourced, not a fake user turn');
    assert.equal(decision.messages[0].source.form, 'notice');
    assert.ok(!('plugin' in decision.messages[0].source), 'no retired `plugin` wrapper field');
    assert.equal(enter.messages.length, 0, 'the downstream batch is never mutated in place');

    // …and never a second time in the same turn
    decision = await preStep({ agent, turn: 1 }, async () => enter);
    assert.equal(decision.messages.length, 0, 'never twice in one turn');

    // a rejected step must not consume the reminder, and must pass through by identity
    const rejected = { kind: 'reject' };
    const afterReject = await preStep({ agent: { id: 'other' }, turn: 5 }, async () => rejected);
    assert.equal(afterReject, rejected, 'a rejected decision is returned untouched');

    // touching the wiki within the same turn earns silence afterwards
    // (note the order: pre-step first to establish the turn, then the tool calls)
    const second = { id: 'second' };
    await preStep({ agent: second, turn: 3 }, async () => enter);
    result({ agent: second, name: 'web_search' }, { content: [] });
    result({ agent: second, name: 'wiki_search' }, { content: [] });
    decision = await preStep({ agent: second, turn: 3 }, async () => enter);
    assert.equal(decision.messages.length, 0, 'a turn that touched the wiki earns silence');

    // Observation never disturbs the step: a foreign decision comes back as built.
    const foreign = { kind: 'enter', messages: [], someFutureField: 'passthrough' };
    const carried = await preStep({ agent: { id: 'quiet' }, turn: 9 }, async () => foreign);
    assert.equal(carried.someFutureField, 'passthrough', 'unknown decision fields survive the fold');
  } finally {
    await rm(wiki.root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------- pass 4: nudge switched off
{
  const wiki = await boot({ approval: 'off', nudge: 'off' }, undefined);
  try {
    assert.equal(wiki.handlers.size, 0, 'nudge: off registers no listeners at all, not a short-circuiting one');
    assert.equal(wiki.registered.size, SEVEN.length, 'the tools are unaffected by the nudge switch');
  } finally {
    await rm(wiki.root, { recursive: true, force: true });
  }
}

console.log('dsh-llm-wiki smoke: OK — review loop, direct writes, link cards, and the next-step nudge all work on the built artifact');
