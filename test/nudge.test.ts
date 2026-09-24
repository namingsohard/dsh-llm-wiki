import { describe, expect, it, vi } from 'vitest';
import {
  createNudgeWatcher,
  registerNudgeHook,
  renderNudge,
  type EnterDecision,
  type NudgeAgent,
  type NudgeMessage,
} from '../src/hooks/wiki-nudge.js';
import type { WikiPromptStats } from '../src/prompt.js';

/**
 * The web-access nudge: observe the turn through the harness event seam, then
 * fold the reminder into the NEXT step's input so the answer the user gets
 * stays the last message of the turn. The harness is faked to its contract:
 * `tools/post-execute(exec, result, next)` and the `agent/pre-step` waterfall
 * `(payload:{agent,turn,step}, next)`, whose `next()` resolves to the `enter`
 * decision the loop would otherwise hand to the model.
 */

const EMPTY: WikiPromptStats = { pages: 0, pending: 0 };

function fakeAgent(id = 'agent-1'): NudgeAgent {
  return { id };
}

function makeWatcher(stats: WikiPromptStats = EMPTY) {
  const logger = { warn: vi.fn(), info: vi.fn() };
  const watcher = createNudgeWatcher({ stats, logger });
  return { watcher, logger };
}

/** What `agent/pre-step`'s innermost default hands us: the batch to enter with. */
function enter(messages: readonly NudgeMessage[] = []): EnterDecision {
  return { kind: 'enter', messages };
}

function textOf(decision: EnterDecision | undefined, index = 0): string {
  return decision!.messages![index]!.content[0]!.text;
}

function fakeHost(agents?: Map<string, unknown>) {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    handlers,
    on: vi.fn((name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, handler);
      return () => undefined;
    }),
    get: vi.fn((name: string) => (name === 'agents' ? agents : undefined)),
    logger: { warn: vi.fn(), info: vi.fn() },
  };
}

describe('web-access nudge: turn accounting', () => {
  it('folds one reminder into the next step when the turn browsed the web untouched by the wiki', () => {
    const { watcher } = makeWatcher({ pages: 7, pending: 0 });
    const agent = fakeAgent();
    watcher.onPreStep({ agent, turn: 1 }, undefined);
    watcher.onPostExecute({ agent, name: 'web_search' });
    watcher.onPostExecute({ agent, name: 'web_fetch' });
    const decision = watcher.onPreStep({ agent, turn: 1 }, enter());

    expect(decision?.kind).toBe('enter');
    expect(decision!.messages).toHaveLength(1);
    expect(textOf(decision)).toContain('2 web call(s)');
    expect(textOf(decision)).toContain('wiki_search');
    expect(textOf(decision)).toContain('7 page(s) on record');
  });

  it('says nothing when the turn touched the wiki at all', () => {
    const { watcher } = makeWatcher();
    const agent = fakeAgent();
    watcher.onPreStep({ agent, turn: 4 }, enter());
    watcher.onPostExecute({ agent, name: 'web_search' });
    watcher.onPostExecute({ agent, name: 'wiki_inspect' });
    expect(watcher.onPreStep({ agent, turn: 4 }, enter())!.messages).toHaveLength(0);
  });

  it('says nothing when the turn never went to the web', () => {
    const { watcher } = makeWatcher();
    const agent = fakeAgent();
    watcher.onPreStep({ agent, turn: 2 }, enter());
    watcher.onPostExecute({ agent, name: 'read' });
    expect(watcher.onPreStep({ agent, turn: 2 }, enter())!.messages).toHaveLength(0);
  });

  it('never reminds the same turn twice, however many steps follow one research burst', () => {
    const { watcher } = makeWatcher();
    const agent = fakeAgent();
    watcher.onPreStep({ agent, turn: 9 }, enter());
    watcher.onPostExecute({ agent, name: 'web_search' });
    expect(watcher.onPreStep({ agent, turn: 9 }, enter())!.messages).toHaveLength(1);
    expect(watcher.onPreStep({ agent, turn: 9 }, enter())!.messages).toHaveLength(0);
    expect(watcher.onPreStep({ agent, turn: 9 }, enter())!.messages).toHaveLength(0);
  });

  it('rearms on the next turn: a quiet turn stays quiet, a fresh web burst earns its own reminder', () => {
    const { watcher } = makeWatcher();
    const agent = fakeAgent();

    watcher.onPreStep({ agent, turn: 1 }, enter());
    watcher.onPostExecute({ agent, name: 'web_search' });
    expect(watcher.onPreStep({ agent, turn: 1 }, enter())!.messages).toHaveLength(1);

    // Turn 2 does no research: no reminder, even though turn 1 was nudged.
    watcher.onPreStep({ agent, turn: 2 }, enter());
    expect(watcher.onPreStep({ agent, turn: 2 }, enter())!.messages).toHaveLength(0);
    expect(watcher.peek(agent)).toMatchObject({ turn: 2, web: 0, wiki: false });

    watcher.onPostExecute({ agent, name: 'web_search' });
    expect(watcher.onPreStep({ agent, turn: 2 }, enter())!.messages).toHaveLength(1);
    // The counters describe the turn; dedupe rides on nudgedTurn, not on wiping them.
    expect(watcher.peek(agent)).toMatchObject({ turn: 2, web: 1, wiki: false, nudgedTurn: 2 });
  });

  it('keeps counters per agent, so a subagent burst cannot spend the main agent’s reminder', () => {
    const { watcher } = makeWatcher();
    const main = fakeAgent('main');
    const other = fakeAgent('other');
    watcher.onPreStep({ agent: main, turn: 1 }, enter());
    watcher.onPreStep({ agent: other, turn: 1 }, enter());
    watcher.onPostExecute({ agent: other, name: 'web_search' });
    expect(watcher.onPreStep({ agent: main, turn: 1 }, enter())!.messages).toHaveLength(0);
    expect(watcher.onPreStep({ agent: other, turn: 1 }, enter())!.messages).toHaveLength(1);
  });

  it('delivers a plugin-sourced user message the harness can accept', () => {
    const { watcher } = makeWatcher();
    const agent = fakeAgent();
    watcher.onPreStep({ agent, turn: 1 }, enter());
    watcher.onPostExecute({ agent, name: 'web_search' });
    const message = watcher.onPreStep({ agent, turn: 1 }, enter())!.messages![0]!;
    expect(message.role).toBe('user');
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-llm-wiki', form: 'notice' });
    expect(message.content[0]!.type).toBe('text');
    expect(message.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('tells an empty wiki apart from a busy one, and mentions what is already pending', () => {
    expect(renderNudge(1, { pages: 0, pending: 0 })).toContain('still empty');
    const busy = renderNudge(3, { pages: 12, pending: 2 });
    expect(busy).toContain('12 page(s) on record');
    expect(busy).toContain('2 proposal(s) already await');
    // The reminder speaks to the model before it composes, and ends by telling
    // it to answer last — the product constraint, spelled out (WIKI-NUDGE-1).
    expect(busy).toContain('Before composing your answer');
    expect(busy).toContain('answer them last');
    expect(busy).toContain('Do not redo work you already finished');
  });

  it('degrades to silence instead of throwing when the loop hands it anything odd', () => {
    const { watcher, logger } = makeWatcher();
    const rejected: EnterDecision = { kind: 'reject' };
    const entered = enter();
    expect(() => {
      expect(watcher.onPreStep(undefined, rejected)).toBe(rejected);
      expect(watcher.onPreStep({}, entered)).toBe(entered);
      expect(watcher.onPreStep({ turn: 1 }, entered)).toBe(entered);
      expect(watcher.onPreStep({ agent: { id: 42 as unknown as string }, turn: 1 }, entered)).toBe(entered);
      expect(watcher.onPreStep({ agent: fakeAgent(), turn: 1 }, undefined)).toBeUndefined();
      watcher.onPostExecute(undefined);
      watcher.onPostExecute({ name: 'web_search' }); // no agent
      watcher.onPostExecute({ agent: { id: 'x' }, name: 42 as unknown as string });
    }).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns the downstream decision untouched when it was rejected, and still owes the reminder', () => {
    const { watcher } = makeWatcher();
    const agent = fakeAgent();
    watcher.onPreStep({ agent, turn: 3 }, enter());
    watcher.onPostExecute({ agent, name: 'web_search' });

    const rejected: EnterDecision = { kind: 'reject' };
    expect(watcher.onPreStep({ agent, turn: 3 }, rejected)).toBe(rejected);
    // A vetoed step consumed nothing: the next step that does enter gets it.
    expect(watcher.onPreStep({ agent, turn: 3 }, enter())!.messages).toHaveLength(1);
  });

  it('preserves startsRequestSeries and never mutates the downstream batch', () => {
    const { watcher } = makeWatcher();
    const agent = fakeAgent();
    watcher.onPreStep({ agent, turn: 6 }, enter());
    watcher.onPostExecute({ agent, name: 'web_search' });

    const batch: NudgeMessage[] = [];
    Object.freeze(batch);
    const decision = watcher.onPreStep({ agent, turn: 6 }, { kind: 'enter', messages: batch, startsRequestSeries: true });
    expect(decision?.kind).toBe('enter');
    expect(decision?.startsRequestSeries).toBe(true);
    expect(decision!.messages).toHaveLength(1);
    expect(batch).toHaveLength(0); // the harness freezes what it publishes; append, never mutate

    // What other listeners folded in keeps its place; the reminder lands last.
    const second = fakeAgent('second');
    watcher.onPreStep({ agent: second, turn: 6 }, enter());
    watcher.onPostExecute({ agent: second, name: 'web_search' });
    const theirs: NudgeMessage = {
      id: 'theirs',
      role: 'user',
      content: [{ type: 'text', text: 'from another plugin' }],
      source: { kind: 'plugin', plugin: 'other', form: 'notice', summary: 'other' },
    };
    const stacked = watcher.onPreStep({ agent: second, turn: 6 }, { kind: 'enter', messages: Object.freeze([theirs]) });
    expect(stacked!.messages).toHaveLength(2);
    expect(stacked!.messages![0]).toBe(theirs);
    expect(textOf(stacked, 1)).toContain('1 web call(s)');
  });
});

describe('web-access nudge: harness wiring', () => {
  it('registers the observation seams and folds on top of the downstream decision', async () => {
    const host = fakeHost();
    registerNudgeHook(host, 'next-step', EMPTY);
    expect([...host.handlers.keys()].sort()).toEqual([
      'agent/pre-step',
      'subagent/start',
      'tools/post-execute',
    ]);

    const downstream = { kind: 'accept', value: { ok: true } };
    const returned = await host.handlers.get('tools/post-execute')!({ name: 'web_search', agent: fakeAgent() }, {}, async () => downstream);
    expect(returned).toBe(downstream);

    const agent = fakeAgent();
    const entered = enter();
    await host.handlers.get('agent/pre-step')!({ agent, turn: 1 }, async () => entered);
    await host.handlers.get('tools/post-execute')!({ agent, name: 'web_search' }, {}, async () => downstream);

    const decision = (await host.handlers.get('agent/pre-step')!({ agent, turn: 1 }, async () => entered)) as EnterDecision;
    expect(decision.kind).toBe('enter');
    expect(decision).not.toBe(entered); // built from the downstream decision, not returned raw
    expect(decision.messages).toHaveLength(1);
    expect(entered.messages).toHaveLength(0);
  });

  it('registers nothing at all when the nudge is off', () => {
    const host = fakeHost();
    const dispose = registerNudgeHook(host, 'off', EMPTY);
    expect(host.on).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it('leaves subagents alone: their parent is the agent worth reminding', async () => {
    const child = fakeAgent('child');
    const host = fakeHost(new Map([['run-7', child]]));
    registerNudgeHook(host, 'next-step', EMPTY);

    const entered = enter();
    host.handlers.get('subagent/start')!({ id: 'run-7', runId: 'run-7' });
    await host.handlers.get('agent/pre-step')!({ agent: child, turn: 1 }, async () => entered);
    await host.handlers.get('tools/post-execute')!({ agent: child, name: 'web_search' }, {}, () => undefined);
    const decision = await host.handlers.get('agent/pre-step')!({ agent: child, turn: 1 }, async () => entered);
    expect(decision).toBe(entered); // excluded: the downstream decision passes through untouched
  });

  it('ignores subagent events it cannot resolve instead of failing', () => {
    const host = fakeHost(); // no `agents` service
    expect(() => host.on.mock.calls.length && host.handlers.get('subagent/start')!({ id: 'nope' })).not.toThrow();
  });
});
