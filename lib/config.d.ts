import Schema from '@deepseek-ai/schemastery';
/**
 * Plugin configuration. The exported {@link Config} is the Schemastery schema
 * surfaced to DSH settings (`settings.yaml`, key `wiki`); {@link resolveConfig}
 * tolerates partial/absent input so the plugin also works in test harnesses
 * that call `apply()` without settings.
 *
 * @module dsh-llm-wiki/config
 */
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
    /** Raw content cap for one source page (bytes); excess is truncated. */
    maxSourceBytes: number;
    /** `wiki_inspect` body cap (bytes); excess is truncated with a flag. */
    maxInspectBytes: number;
    /** Whether the linter reports orphan pages. */
    lintOrphans: boolean;
    /** Whether mutations are appended to `logs/`. */
    mutationLog: boolean;
}
export declare const DEFAULT_CONFIG: WikiConfig;
/** Schemastery configuration for the `wiki` plugin consumer. */
export declare const Config: Schema<Schemastery.ObjectS<{
    wikiRoot: Schema<string, string>;
    searchLimit: Schema<number, number>;
    includeSourcesInSearch: Schema<boolean, boolean>;
    agingAfterDays: Schema<number, number>;
    staleAfterDays: Schema<number, number>;
    admissionMinAverage: Schema<number, number>;
    admissionMinIndividual: Schema<number, number>;
    maxPageBytes: Schema<number, number>;
    maxSourceBytes: Schema<number, number>;
    maxInspectBytes: Schema<number, number>;
    lintOrphans: Schema<boolean, boolean>;
    mutationLog: Schema<boolean, boolean>;
}>, Schemastery.ObjectT<{
    wikiRoot: Schema<string, string>;
    searchLimit: Schema<number, number>;
    includeSourcesInSearch: Schema<boolean, boolean>;
    agingAfterDays: Schema<number, number>;
    staleAfterDays: Schema<number, number>;
    admissionMinAverage: Schema<number, number>;
    admissionMinIndividual: Schema<number, number>;
    maxPageBytes: Schema<number, number>;
    maxSourceBytes: Schema<number, number>;
    maxInspectBytes: Schema<number, number>;
    lintOrphans: Schema<boolean, boolean>;
    mutationLog: Schema<boolean, boolean>;
}>>;
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