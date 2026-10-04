import { randomUUID } from 'node:crypto';
import type { WikiNudgeMode } from '../config.js';
import type { WikiPromptStats } from '../prompt.js';

/**
 * The web-access nudge: when a turn goes to the web without involving the
 * wiki, fold one reminder into the **next step's input** — before the model
 * composes the answer it owes the user.
 *
 * Why the next step. The resident prompt already says "wiki-first", and a
 * prompt is the weakest constraint in the system: under load the model skips
 * it. This module is the enforcement a prompt cannot be. It listens on
 * `tools/result` to observe what the turn did (an emit: never blocking, never
 * rewriting, and the harness contains a throwing listener), and on
 * `agent/pre-step`, whose `enter` decision carries the messages about to be
 * handed to the model. Appending there is what the official context-injecting
 * plugins do, it costs no extra step, and the turn is never extended — so the
 * user-facing answer stays the last message of the turn. The placement is
 * natural: every web tool call is followed by another step (only a tool
 * declaring `concludesTurn` ends a turn early, and `web_search` / `web_fetch` do
 * not), and that step is exactly where the model reads the results and starts
 * composing.
 *
 * Why not the turn boundary. The previous design listened on
 * `agent/turn-stopping` and delivered with `agent.steer()`. That fires *after*
 * the answer has been generated and appended, and the loop re-checks the
 * next-step inbox before breaking, so the steer necessarily bought one more
 * step — which made bookkeeping prose ("saved it to the wiki, awaiting your
 * review") the final message of the turn and pushed the real answer off the
 * last screen. Reverted per ticket WIKI-NUDGE-1; do not reintroduce it.
 * `agent.inject()` is no escape either: it writes to the same `nextStep`
 * inbox the loop re-checks, so it extends the turn exactly the same way.
 *
 * Why not after every web call. Research happens in bursts: a task may fire a
 * dozen searches in its opening minutes. Reminding after each one spends the
 * model's attention on the same sentence twelve times. What actually matters
 * is that the knowledge gets written eventually, so one reminder per turn,
 * placed where the model still has steps left to act, covers the whole burst.
 *
 * Host compatibility (the versions `package.json` peers admit): `tools/result`,
 * `agent/pre-step`, `subagent/start` and the `{ id, role, content, source }`
 * message shape are declared identically from 0.1.5-rc.1 through 0.1.7-rc.2, so
 * this module needs no version branching — with one exception, the message
 * `source`, which session format v4 tightened; see {@link NUDGE_SOURCE_KIND}.
 *
 * Position in the pre-step waterfall: we `await next()` first and append to
 * the decision the listeners behind us produced. They keep the power to veto
 * or rewrite the step; we only ever add to their result and they do not see
 * our message. Folding the other way round would be equally legal, just
 * silent in the other direction.
 *
 * @module dsh-llm-wiki/hooks/wiki-nudge
 */

/** Any wiki tool call counts: the wiki was part of the turn, however it was used. */
export const WIKI_TOOL_NAMES: readonly string[] = [
  'wiki_search',
  'wiki_inspect',
  'wiki_source_save',
  'wiki_mutate',
  'wiki_review',
  'wiki_lint',
  'wiki_guide',
];

/** Tools that mean "the answer came from outside the wiki". */
export const WEB_TOOL_NAMES: readonly string[] = ['web_search', 'web_fetch'];

const PLUGIN_NAME = 'dsh-llm-wiki';

/**
 * The durable producer kind stamped on every reminder.
 *
 * Session format v4 (`dsh` 0.1.7-alpha.1 and later) retired the
 * `{ kind: 'plugin', plugin: <name> }` wrapper: `dsh-session-format-v3-to-v4`
 * refuses it on the append path — "format v4 message requires a producer-owned
 * source kind" — and lifts legacy rows of producers it does not know to
 * `plugin:<name>`. So `plugin:dsh-llm-wiki` is what v4 wants *and* what our own
 * pre-v4 reminders become when a host migrates a session, which keeps old and
 * new rows attributed identically. The v3 hosts in the supported range
 * (0.1.5-rc.1 … 0.1.6-alpha.2) only require a non-empty `kind` string on a
 * `user/message`, so this single spelling is valid across the whole range.
 */
export const NUDGE_SOURCE_KIND = `plugin:${PLUGIN_NAME}`;

/**
 * The message shape the harness accepts in `agent/pre-step`'s `enter.messages`
 * — `{ id, role, content, source }`, built structurally because the harness
 * module that mints these (`@deepseek-ai/dsh-llm`) is not a dependency of this
 * plugin. The bundled `dsh-repeat-tool-reminder` plugin carries its own copy of
 * the same helper. `source.kind` + `form: 'notice'` is what makes the reminder a
 * plugin-signed notice in the UI rather than a fake user turn.
 */
export interface NudgeMessage {
  readonly id: string;
  readonly role: 'user';
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  /** Producer attribution — see {@link NUDGE_SOURCE_KIND} for why `kind` is not `'plugin'`. */
  readonly source: {
    readonly kind: string;
    readonly form: 'notice';
    readonly summary: string;
  };
}

/** The part of an `Agent` this module touches. */
export interface NudgeAgent {
  readonly id: string;
}

/** Minimal logger surface (matches the Cordis `ctx.logger` shape we use). */
export interface NudgeLogger {
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
}

interface ToolResultPayload {
  readonly name?: unknown;
  readonly agent?: unknown;
}

interface TurnPayload {
  readonly agent?: unknown;
  readonly turn?: unknown;
}

/** The `agent/pre-step` decision shape this module folds context into. */
export interface EnterDecision {
  readonly kind: 'reject' | 'enter';
  readonly messages?: readonly NudgeMessage[];
  readonly startsRequestSeries?: true;
}

/** What one agent did in the turn currently being watched. */
interface TurnWatch {
  /** Turn number the counters belong to (`-1` until the first pre-step). */
  turn: number;
  /** Web tool calls observed in this turn. */
  web: number;
  /** Whether any wiki tool ran in this turn. */
  wiki: boolean;
  /** Turn we last reminded on, so a turn is never reminded twice. */
  nudgedTurn: number;
}

/** Test seam: the observable counters for one agent. */
export interface WatchSnapshot {
  turn: number;
  web: number;
  wiki: boolean;
  nudgedTurn: number;
}

export interface NudgeWatcherOptions {
  stats: WikiPromptStats;
  logger?: NudgeLogger | undefined;
  /** Agents to leave alone (subagents: their parent gets nudged anyway). */
  excluded?: WeakSet<object>;
}

export interface NudgeWatcher {
  /**
   * `agent/pre-step`: rearm the counters when the turn changes, then fold the
   * reminder (when one is owed) into the downstream `enter` decision. Returns
   * the decision to hand back to the harness — unchanged when there is nothing
   * to add, so other listeners' decisions are never disturbed.
   */
  onPreStep(payload: TurnPayload | undefined, downstream: EnterDecision | undefined): EnterDecision | undefined;
  /** `tools/result`: record which side of the fence this call was on. */
  onToolResult(exec: ToolResultPayload | undefined): void;
  /** Inspect the counters for one agent (tests and diagnostics). */
  peek(agent: NudgeAgent): WatchSnapshot | undefined;
}

/** Render the reminder the model receives as a plugin-sourced user message. */
export function renderNudge(webCalls: number, stats: WikiPromptStats): string {
  const state = stats.pages === 0
    ? 'the wiki is still empty, which is exactly when it should be seeded'
    : `the wiki has ${stats.pages} page(s) on record`;
  const pending = stats.pending > 0 ? ` ${stats.pending} proposal(s) already await the user's wiki_review.` : '';
  return [
    `[${PLUGIN_NAME}] This turn made ${webCalls} web call(s) and never touched the wiki (${state}).${pending}`,
    'Before composing your answer, run wiki_search on what you just learned.',
    'Do not redo work you already finished.',
    'If any of it is durable — a mechanism, a product fact, a decision you will reuse — write it once, before you answer:',
    'wiki_source_save for the link, then wiki_mutate for the page; the write gate holds it for the user.',
    'If nothing here is worth keeping, skip it silently and answer the user — and answer them last.',
  ].join('\n');
}

function buildMessage(text: string): NudgeMessage {
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    content: Object.freeze([{ type: 'text' as const, text }]),
    source: Object.freeze({
      kind: NUDGE_SOURCE_KIND,
      form: 'notice' as const,
      summary: 'wiki-first reminder',
    }),
  });
}

/**
 * Build the per-agent turn tracker. Both handlers are total: a malformed
 * payload, a missing agent, or a missing/foreign downstream decision degrades
 * to passing the downstream through untouched, because these run inside the
 * step loop where a throw would cost the user their turn.
 */
export function createNudgeWatcher(options: NudgeWatcherOptions): NudgeWatcher {
  const watches = new WeakMap<NudgeAgent, TurnWatch>();
  const excluded = options.excluded;

  const warn = (message: string, error: unknown): void => {
    try {
      options.logger?.warn?.(`dsh-llm-wiki nudge: ${message}: ${String(error)}`);
    } catch {
      // A broken logger must not break the loop either.
    }
  };

  function watchFor(agent: NudgeAgent): TurnWatch {
    let watch = watches.get(agent);
    if (watch === undefined) {
      watch = { turn: -1, web: 0, wiki: false, nudgedTurn: -1 };
      watches.set(agent, watch);
    }
    return watch;
  }

  function asAgent(value: unknown): NudgeAgent | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const candidate = value as NudgeAgent;
    if (typeof candidate.id !== 'string') return undefined;
    if (excluded?.has(candidate)) return undefined;
    return candidate;
  }

  function asTurn(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : -1;
  }

  function onPreStep(payload: TurnPayload | undefined, downstream: EnterDecision | undefined): EnterDecision | undefined {
    const agent = asAgent(payload?.agent);
    if (agent === undefined) return downstream;
    const turn = asTurn(payload?.turn);
    const watch = watchFor(agent);
    if (watch.turn === -1) {
      // First pre-step we happen to see for this agent. Adopt the turn number
      // but KEEP any counts already observed: a tool can be observed before the
      // first pre-step reaches us (harness ordering, or a listener registered
      // late), and dropping those counts would silently lose the reminder.
      watch.turn = turn;
    } else if (turn >= 0 && watch.turn !== turn) {
      // A new turn: a fresh research burst starts from zero.
      watch.turn = turn;
      watch.web = 0;
      watch.wiki = false;
    }
    if (downstream?.kind !== 'enter') return downstream; // rejected or absent: the reminder stays owed
    if (watch.web === 0 || watch.wiki) return downstream; // nothing to say
    if (watch.nudgedTurn === turn) return downstream; // already said it this turn

    // Claim it before publishing: the turn gets exactly one reminder whatever
    // the harness does with the message.
    watch.nudgedTurn = turn;
    const reminder = buildMessage(renderNudge(watch.web, options.stats));
    // Never mutate the downstream batch — the harness freezes what it publishes.
    const messages = [...(downstream.messages ?? []), reminder];
    // Spread the downstream decision and replace only its message batch, so a
    // decision field newer than this plugin survives us.
    return { ...downstream, messages };
  }

  function onToolResult(exec: ToolResultPayload | undefined): void {
    const agent = asAgent(exec?.agent);
    if (agent === undefined || typeof exec?.name !== 'string') return;
    const watch = watchFor(agent);
    if (WIKI_TOOL_NAMES.includes(exec.name)) watch.wiki = true;
    else if (WEB_TOOL_NAMES.includes(exec.name)) watch.web++;
  }

  return {
    onPreStep: (payload, downstream) => {
      try {
        return onPreStep(payload, downstream);
      } catch (error) {
        warn('pre-step failed', error);
        return downstream;
      }
    },
    onToolResult: (exec) => {
      try {
        onToolResult(exec);
      } catch (error) {
        warn('tool-result observation failed', error);
      }
    },
    peek: (agent) => {
      const watch = watches.get(agent);
      return watch === undefined ? undefined : { ...watch };
    },
  };
}

/** The plugin-side surface the hook needs from the Cordis context. */
export interface NudgeHost {
  on?(event: string, handler: (...args: any[]) => unknown): (() => void) | void;
  get?(name: string, strict?: boolean): unknown;
  logger?: NudgeLogger | undefined;
}

function asDisposer(result: (() => void) | void): () => void {
  return typeof result === 'function' ? result : () => undefined;
}

/**
 * Wire the watcher into the harness event seam. Returns a disposer. With
 * `mode: 'off'` no listener is registered at all, so a deployment that does
 * not want this behaviour pays nothing for it.
 */
export function registerNudgeHook(host: NudgeHost, mode: WikiNudgeMode, stats: WikiPromptStats): () => void {
  if (mode !== 'next-step' || typeof host.on !== 'function') return () => undefined;

  // Subagents are tracked so the reminder lands on the agent the user is
  // waiting on. `subagent/start` is the seam the bundled hooks plugins use;
  // when it is unavailable every agent is watched, which is harmless.
  const subagents = new WeakSet<object>();
  const agents = (): Map<string, object> | undefined => {
    const service = host.get?.('agents', false);
    return typeof (service as { get?: unknown } | undefined)?.get === 'function'
      ? (service as unknown as Map<string, object>)
      : undefined;
  };

  const disposers: (() => void)[] = [
    asDisposer(host.on('subagent/start', (info: { id?: unknown }) => {
      try {
        const child = info !== null && typeof info === 'object' && typeof info.id === 'string' ? agents()?.get(info.id) : undefined;
        if (child !== undefined) subagents.add(child);
      } catch (error) {
        host.logger?.warn?.('dsh-llm-wiki nudge: could not track subagent: %s', String(error));
      }
    })),
  ];

  const watcher = createNudgeWatcher({ stats, logger: host.logger, excluded: subagents });

  disposers.push(
    // Observation rides the emit, not the `tools/post-execute` waterfall: the
    // counters are read-only interest in the outcome, and an emit keeps a
    // throwing listener inside the harness's own containment instead of the
    // step's decision path.
    asDisposer(host.on('tools/result', (exec: unknown) => {
      watcher.onToolResult(exec as ToolResultPayload | undefined);
    })),
    // Delegate to the listeners behind us first, then fold our context into
    // whatever decision they produced (see the module note on waterfall order).
    asDisposer(host.on('agent/pre-step', async (payload: unknown, next: unknown) => {
      const downstream = typeof next === 'function'
        ? (await (next as () => Promise<EnterDecision | undefined>)())
        : undefined;
      return watcher.onPreStep(payload as TurnPayload | undefined, downstream);
    })),
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // One disposer failing must not skip the rest.
      }
    }
  };
}
