/** Concise core guidance used when the playbook files cannot be read. */
export declare const FALLBACK_CORE = "# DSH-Wiki \u00B7 Agent Semantic Memory\n\nYou have a persistent file-based wiki (~/.dsh/wiki) for cross-task knowledge.\nwiki_search first for research questions; reuse what coverage says is high.\nAfter web research: wiki_source_save the material, then wiki_mutate\n(create with admission scores / update / merge / link / deprecate).\nRun wiki_lint after mutation batches. Never delete; deprecate instead.";
/** Kick off the async prefetch; rejections degrade to the fallback text. */
export declare function createPromptSource(logger?: {
    warn?: (message: string, ...args: unknown[]) => void;
}): {
    provider: (wikiRootDisplay: string) => string;
    prefetch: () => Promise<void>;
};
//# sourceMappingURL=prompt.d.ts.map