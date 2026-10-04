import Schema from '@deepseek-ai/schemastery';
/**
 * Plugin configuration. The exported {@link Config} is the Schemastery schema
 * surfaced to DSH settings (`settings.yaml`, key `wiki`); {@link resolveConfig}
 * tolerates partial/absent input so the plugin also works in test harnesses
 * that call `apply()` without settings.
 *
 * @module dsh-llm-wiki/config
 */
/**
 * How a write reaches the live wiki.
 * - `staging`: proposed writes park in `staging/` (invisible to search and lint)
 *   until the user approves them through `wiki_review`. The default.
 * - `inline`: ask through the harness approval seam at call time.
 * - `off`: apply writes immediately (the v0.1 behaviour).
 */
export type WikiApprovalMode = 'staging' | 'inline' | 'off';
/**
 * The web-access nudge (see `hooks/wiki-nudge.ts`).
 * - `next-step`: when a turn used web tools without any wiki tool, fold one
 *   reminder into the next step's input — before the model composes its answer,
 *   and without extending the turn. The default.
 * - `off`: register no listeners; the prompt is the only guidance.
 * The legacy spelling `turn-end` is accepted and normalized to `next-step`.
 */
export type WikiNudgeMode = 'next-step' | 'off';
/** Fully-resolved plugin configuration. */
export interface WikiConfig {
    /** Absolute-or-empty wiki root. Empty means "auto-resolve" (see {@link resolveWikiRoot}). */
    wikiRoot: string;
    /** Default `wiki_search` result count. */
    searchLimit: number;
    /** Whether `wiki_search` includes the Source Layer by default. */
    includeSourcesInSearch: boolean;
    /** Age after which a page is reported `aging`. */
    agingAfterDays: number;
    /** Age after which a page is reported `stale`. */
    staleAfterDays: number;
    /** CREATE admission: required mean of the four scores. */
    admissionMinAverage: number;
    /** CREATE admission: required floor on every individual score. */
    admissionMinIndividual: number;
    /** Hard cap on one wiki page file (bytes). */
    maxPageBytes: number;
    /** `wiki_inspect` body cap (bytes); excess is truncated with a flag. */
    maxInspectBytes: number;
    /** Whether the linter reports orphan pages. */
    lintOrphans: boolean;
    /** Whether mutations are appended to `logs/`. */
    mutationLog: boolean;
    /** Write gate: how a proposed write reaches the live wiki. */
    approval: WikiApprovalMode;
    /** Cap on one staged payload (bytes); oversized writes are refused at stage time. */
    maxStagedBytes: number;
    /** Reminder folded into the next step after a turn browsed the web without the wiki. */
    nudge: WikiNudgeMode;
}
export declare const DEFAULT_CONFIG: WikiConfig;
/** Schemastery configuration for the `wiki` plugin consumer. */
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    wikiRoot: Schema<string, string, "defined">;
    searchLimit: Schema<number, number, "defined">;
    includeSourcesInSearch: Schema<boolean, boolean, "defined">;
    agingAfterDays: Schema<number, number, "defined">;
    staleAfterDays: Schema<number, number, "defined">;
    admissionMinAverage: Schema<number, number, "defined">;
    admissionMinIndividual: Schema<number, number, "defined">;
    maxPageBytes: Schema<number, number, "defined">;
    maxInspectBytes: Schema<number, number, "defined">;
    lintOrphans: Schema<boolean, boolean, "defined">;
    mutationLog: Schema<boolean, boolean, "defined">;
    approval: Schema<"staging" | "inline" | "off", "staging" | "inline" | "off", "defined">;
    maxStagedBytes: Schema<number, number, "defined">;
    nudge: Schema<"off" | "next-step" | "turn-end", "off" | "next-step" | "turn-end", "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    wikiRoot: Schema<string, string, "defined">;
    searchLimit: Schema<number, number, "defined">;
    includeSourcesInSearch: Schema<boolean, boolean, "defined">;
    agingAfterDays: Schema<number, number, "defined">;
    staleAfterDays: Schema<number, number, "defined">;
    admissionMinAverage: Schema<number, number, "defined">;
    admissionMinIndividual: Schema<number, number, "defined">;
    maxPageBytes: Schema<number, number, "defined">;
    maxInspectBytes: Schema<number, number, "defined">;
    lintOrphans: Schema<boolean, boolean, "defined">;
    mutationLog: Schema<boolean, boolean, "defined">;
    approval: Schema<"staging" | "inline" | "off", "staging" | "inline" | "off", "defined">;
    maxStagedBytes: Schema<number, number, "defined">;
    nudge: Schema<"off" | "next-step" | "turn-end", "off" | "next-step" | "turn-end", "defined">;
}>>, "plain">;
/** Fill defaults and normalize inter-field constraints. */
export declare function resolveConfig(config?: Partial<WikiConfig> | undefined): WikiConfig;
/** Expand `~`, `~/`, `~\` against the OS home. */
export declare function expandHomePath(input: string): string;
/**
 * Resolve the wiki root. Precedence: `$DSH_WIKI_ROOT`, an explicit configured
 * path, then `$DSH_HOME/wiki`, then `~/.dsh/wiki` — mirroring how the harness
 * resolves its own home.
 */
export declare function resolveWikiRoot(config: Pick<WikiConfig, 'wikiRoot'>, env?: NodeJS.ProcessEnv): string;
//# sourceMappingURL=config.d.ts.map