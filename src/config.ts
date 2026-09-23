import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

export const DEFAULT_CONFIG: WikiConfig = {
  wikiRoot: '',
  searchLimit: 8,
  includeSourcesInSearch: false,
  agingAfterDays: 90,
  staleAfterDays: 365,
  admissionMinAverage: 1.75,
  admissionMinIndividual: 1,
  maxPageBytes: 64 * 1024,
  maxSourceBytes: 256 * 1024,
  maxInspectBytes: 24 * 1024,
  lintOrphans: true,
  mutationLog: true,
};

/** Schemastery configuration for the `wiki` plugin consumer. */
export const Config = Schema.object({
  wikiRoot: Schema.string()
    .default(DEFAULT_CONFIG.wikiRoot)
    .description('Wiki root directory. Empty means auto: $DSH_WIKI_ROOT, then $DSH_HOME/wiki, then ~/.dsh/wiki. `~` is expanded.'),
  searchLimit: Schema.number()
    .min(1)
    .max(50)
    .default(DEFAULT_CONFIG.searchLimit)
    .description('Default number of hits returned by wiki_search.'),
  includeSourcesInSearch: Schema.boolean()
    .default(DEFAULT_CONFIG.includeSourcesInSearch)
    .description('Whether wiki_search searches the Source Layer (raw materials) by default.'),
  agingAfterDays: Schema.number()
    .min(1)
    .max(3650)
    .default(DEFAULT_CONFIG.agingAfterDays)
    .description('Page age in days after which knowledge is reported as aging.'),
  staleAfterDays: Schema.number()
    .min(1)
    .max(3650)
    .default(DEFAULT_CONFIG.staleAfterDays)
    .description('Page age in days after which knowledge is reported as stale.'),
  admissionMinAverage: Schema.number()
    .min(0)
    .max(3)
    .default(DEFAULT_CONFIG.admissionMinAverage)
    .description('Mean admission score (reusability/stability/novelty/abstraction, each 0-3) a CREATE must reach.'),
  admissionMinIndividual: Schema.number()
    .min(0)
    .max(3)
    .default(DEFAULT_CONFIG.admissionMinIndividual)
    .description('Floor every individual admission score must reach for a CREATE.'),
  maxPageBytes: Schema.number()
    .min(1024)
    .max(1024 * 1024)
    .default(DEFAULT_CONFIG.maxPageBytes)
    .description('Hard size cap for one wiki page file, in bytes.'),
  maxSourceBytes: Schema.number()
    .min(1024)
    .max(2 * 1024 * 1024)
    .default(DEFAULT_CONFIG.maxSourceBytes)
    .description('Raw content cap for one source page, in bytes; excess content is truncated.'),
  maxInspectBytes: Schema.number()
    .min(1024)
    .max(1024 * 1024)
    .default(DEFAULT_CONFIG.maxInspectBytes)
    .description('Body cap for a single wiki_inspect response, in bytes.'),
  lintOrphans: Schema.boolean()
    .default(DEFAULT_CONFIG.lintOrphans)
    .description('Whether wiki_lint reports orphan pages (no inbound links).'),
  mutationLog: Schema.boolean()
    .default(DEFAULT_CONFIG.mutationLog)
    .description('Whether mutations are appended to the wiki logs/ journal.'),
});

/** Fill defaults and normalize inter-field constraints. */
export function resolveConfig(config?: Partial<WikiConfig> | undefined): WikiConfig {
  const merged: WikiConfig = {
    wikiRoot: config?.wikiRoot ?? DEFAULT_CONFIG.wikiRoot,
    searchLimit: config?.searchLimit ?? DEFAULT_CONFIG.searchLimit,
    includeSourcesInSearch: config?.includeSourcesInSearch ?? DEFAULT_CONFIG.includeSourcesInSearch,
    agingAfterDays: config?.agingAfterDays ?? DEFAULT_CONFIG.agingAfterDays,
    staleAfterDays: config?.staleAfterDays ?? DEFAULT_CONFIG.staleAfterDays,
    admissionMinAverage: config?.admissionMinAverage ?? DEFAULT_CONFIG.admissionMinAverage,
    admissionMinIndividual: config?.admissionMinIndividual ?? DEFAULT_CONFIG.admissionMinIndividual,
    maxPageBytes: config?.maxPageBytes ?? DEFAULT_CONFIG.maxPageBytes,
    maxSourceBytes: config?.maxSourceBytes ?? DEFAULT_CONFIG.maxSourceBytes,
    maxInspectBytes: config?.maxInspectBytes ?? DEFAULT_CONFIG.maxInspectBytes,
    lintOrphans: config?.lintOrphans ?? DEFAULT_CONFIG.lintOrphans,
    mutationLog: config?.mutationLog ?? DEFAULT_CONFIG.mutationLog,
  };
  // A page cannot be stale before it is aging.
  if (merged.staleAfterDays < merged.agingAfterDays) merged.staleAfterDays = merged.agingAfterDays;
  return merged;
}

/** Expand `~`, `~/`, `~\` against the OS home. */
export function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2));
  return input;
}

/**
 * Resolve the wiki root. Precedence: `$DSH_WIKI_ROOT`, an explicit configured
 * path, then `$DSH_HOME/wiki`, then `~/.dsh/wiki` — mirroring how the harness
 * resolves its own home.
 */
export function resolveWikiRoot(config: Pick<WikiConfig, 'wikiRoot'>, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['DSH_WIKI_ROOT'];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(expandHomePath(fromEnv.trim()));
  if (config.wikiRoot.trim().length > 0) return resolve(expandHomePath(config.wikiRoot.trim()));
  const dshHome = env['DSH_HOME'];
  const home = dshHome !== undefined && dshHome.trim().length > 0 ? expandHomePath(dshHome.trim()) : join(homedir(), '.dsh');
  return resolve(join(home, 'wiki'));
}
