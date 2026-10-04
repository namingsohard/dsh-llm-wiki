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
export declare const WIKI_TOOL_NAMES: readonly string[];
/** Tools that mean "the answer came from outside the wiki". */
export declare const WEB_TOOL_NAMES: readonly string[];
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
export declare const NUDGE_SOURCE_KIND = "plugin:dsh-llm-wiki";
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
    readonly content: readonly {
        readonly type: 'text';
        readonly text: string;
    }[];
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
export declare function renderNudge(webCalls: number, stats: WikiPromptStats): string;
/**
 * Build the per-agent turn tracker. Both handlers are total: a malformed
 * payload, a missing agent, or a missing/foreign downstream decision degrades
 * to passing the downstream through untouched, because these run inside the
 * step loop where a throw would cost the user their turn.
 */
export declare function createNudgeWatcher(options: NudgeWatcherOptions): NudgeWatcher;
/** The plugin-side surface the hook needs from the Cordis context. */
export interface NudgeHost {
    on?(event: string, handler: (...args: any[]) => unknown): (() => void) | void;
    get?(name: string, strict?: boolean): unknown;
    logger?: NudgeLogger | undefined;
}
/**
 * Wire the watcher into the harness event seam. Returns a disposer. With
 * `mode: 'off'` no listener is registered at all, so a deployment that does
 * not want this behaviour pays nothing for it.
 */
export declare function registerNudgeHook(host: NudgeHost, mode: WikiNudgeMode, stats: WikiPromptStats): () => void;
export {};
//# sourceMappingURL=wiki-nudge.d.ts.map