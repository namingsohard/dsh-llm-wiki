import type { WikiConfig } from '../config.js';
import type { WikiStore } from '../storage/markdown-store.js';
import type { Mutator } from '../mutation/mutator.js';
/**
 * The five model-facing tools. They are the plugin's whole external surface:
 * retrieval (`wiki_search`, `wiki_inspect`), the Source Layer
 * (`wiki_source_save`), the Mutation Engine (`wiki_mutate`), and the Linter
 * (`wiki_lint`). All paths resolve inside the configured wiki root; ids are
 * validated so no call can escape it.
 *
 * Parameter notes for the dsh-tools schema DSL: optional properties OMIT
 * `required` (only `required: true` exists), and every object node states
 * `additionalProperties` explicitly.
 *
 * @module dsh-llm-wiki/tools
 */
/** Registration context: just the tool runtime and a logger. */
export interface ToolsHost {
    tools: {
        register(tool: {
            name: string;
        }): unknown;
    };
    logger?: {
        warn?: (message: string, ...args: unknown[]) => void;
        info?: (message: string, ...args: unknown[]) => void;
    } | undefined;
}
export declare function registerWikiTools(ctx: ToolsHost, store: WikiStore, mutator: Mutator, config: WikiConfig): void;
//# sourceMappingURL=wiki-tools.d.ts.map