import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export const DEFAULT_CONFIG = {
    wikiRoot: '',
    searchLimit: 8,
    includeSourcesInSearch: false,
    agingAfterDays: 90,
    staleAfterDays: 365,
    admissionMinAverage: 1.75,
    admissionMinIndividual: 1,
    maxPageBytes: 64 * 1024,
    maxInspectBytes: 24 * 1024,
    lintOrphans: true,
    mutationLog: true,
    approval: 'staging',
    maxStagedBytes: 64 * 1024,
    nudge: 'next-step',
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
        .description('Whether wiki_search searches the Source Layer (source cards: titles and links) by default.'),
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
    approval: Schema.union([Schema.const('staging'), Schema.const('inline'), Schema.const('off')])
        .default(DEFAULT_CONFIG.approval)
        .description('Write gate. staging (default): every write parks in <wiki>/staging/ (invisible to search and lint) until the user approves it through wiki_review; inline: the same gate, but the write itself prompts through the harness approval channel; off: apply writes immediately.'),
    maxStagedBytes: Schema.natural()
        .default(DEFAULT_CONFIG.maxStagedBytes)
        .description('Cap on one staged payload in bytes; oversized bodies are refused at stage time rather than truncated.'),
    nudge: Schema.union([Schema.const('next-step'), Schema.const('turn-end'), Schema.const('off')])
        .default(DEFAULT_CONFIG.nudge)
        .description('Web-access nudge. next-step (default): if a turn called web_search / web_fetch while no wiki tool ran, fold one reminder into the next step input so the model checks the wiki before composing its answer (the turn is not extended). "turn-end" is accepted as a legacy alias for next-step. off: no listeners are registered.'),
});
/** Fill defaults and normalize inter-field constraints. */
export function resolveConfig(config) {
    const merged = {
        wikiRoot: config?.wikiRoot ?? DEFAULT_CONFIG.wikiRoot,
        searchLimit: config?.searchLimit ?? DEFAULT_CONFIG.searchLimit,
        includeSourcesInSearch: config?.includeSourcesInSearch ?? DEFAULT_CONFIG.includeSourcesInSearch,
        agingAfterDays: config?.agingAfterDays ?? DEFAULT_CONFIG.agingAfterDays,
        staleAfterDays: config?.staleAfterDays ?? DEFAULT_CONFIG.staleAfterDays,
        admissionMinAverage: config?.admissionMinAverage ?? DEFAULT_CONFIG.admissionMinAverage,
        admissionMinIndividual: config?.admissionMinIndividual ?? DEFAULT_CONFIG.admissionMinIndividual,
        maxPageBytes: config?.maxPageBytes ?? DEFAULT_CONFIG.maxPageBytes,
        maxInspectBytes: config?.maxInspectBytes ?? DEFAULT_CONFIG.maxInspectBytes,
        lintOrphans: config?.lintOrphans ?? DEFAULT_CONFIG.lintOrphans,
        mutationLog: config?.mutationLog ?? DEFAULT_CONFIG.mutationLog,
        approval: config?.approval ?? DEFAULT_CONFIG.approval,
        maxStagedBytes: config?.maxStagedBytes ?? DEFAULT_CONFIG.maxStagedBytes,
        // Absent, legacy (`turn-end`) and foreign values all normalize to the one
        // live mode; only an explicit `off` turns the hook off.
        nudge: String(config?.nudge ?? DEFAULT_CONFIG.nudge) === 'off' ? 'off' : 'next-step',
    };
    // A page cannot be stale before it is aging.
    if (merged.staleAfterDays < merged.agingAfterDays)
        merged.staleAfterDays = merged.agingAfterDays;
    // A hand-edited settings.yaml must not silently disable the write gate.
    if (merged.approval !== 'staging' && merged.approval !== 'inline' && merged.approval !== 'off')
        merged.approval = DEFAULT_CONFIG.approval;
    if (merged.maxStagedBytes < 1024)
        merged.maxStagedBytes = 1024;
    return merged;
}
/** Expand `~`, `~/`, `~\` against the OS home. */
export function expandHomePath(input) {
    if (input === '~')
        return homedir();
    if (input.startsWith('~/') || input.startsWith('~\\'))
        return join(homedir(), input.slice(2));
    return input;
}
/**
 * Resolve the wiki root. Precedence: `$DSH_WIKI_ROOT`, an explicit configured
 * path, then `$DSH_HOME/wiki`, then `~/.dsh/wiki` — mirroring how the harness
 * resolves its own home.
 */
export function resolveWikiRoot(config, env = process.env) {
    const fromEnv = env['DSH_WIKI_ROOT'];
    if (fromEnv !== undefined && fromEnv.trim().length > 0)
        return resolve(expandHomePath(fromEnv.trim()));
    if (config.wikiRoot.trim().length > 0)
        return resolve(expandHomePath(config.wikiRoot.trim()));
    const dshHome = env['DSH_HOME'];
    const home = dshHome !== undefined && dshHome.trim().length > 0 ? expandHomePath(dshHome.trim()) : join(homedir(), '.dsh');
    return resolve(join(home, 'wiki'));
}
//# sourceMappingURL=config.js.map