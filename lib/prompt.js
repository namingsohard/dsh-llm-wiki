import { readFile } from 'node:fs/promises';
/**
 * System-prompt contribution builder. The playbook files live in the
 * package's `prompts/` directory so deployments can tune the guidance
 * without rebuilding; they are prefetched at plugin start and served to the
 * prompt section provider from cache. If a file is missing the embedded
 * fallback keeps the plugin functional.
 *
 * @module dsh-llm-wiki/prompt
 */
const PLAYBOOK_FILES = ['router.md', 'extraction.md', 'mutation.md', 'validation.md'];
/** Concise core guidance used when the playbook files cannot be read. */
export const FALLBACK_CORE = `# DSH-Wiki · Agent Semantic Memory

You have a persistent file-based wiki (~/.dsh/wiki) for cross-task knowledge.
wiki_search first for research questions; reuse what coverage says is high.
After web research: wiki_source_save the material, then wiki_mutate
(create with admission scores / update / merge / link / deprecate).
Run wiki_lint after mutation batches. Never delete; deprecate instead.`;
function playbookUrl(name) {
    return new URL(`../prompts/${name}`, import.meta.url);
}
/** Kick off the async prefetch; rejections degrade to the fallback text. */
export function createPromptSource(logger) {
    const cache = { loaded: false, playbooks: [] };
    const prefetch = async () => {
        try {
            const texts = await Promise.all(PLAYBOOK_FILES.map(async (name) => (await readFile(playbookUrl(name), 'utf8')).trim()));
            cache.playbooks = texts;
            cache.loaded = true;
        }
        catch (error) {
            logger?.warn?.('dsh-llm-wiki: prompt playbooks unavailable, using fallback: %s', error instanceof Error ? error.message : String(error));
        }
    };
    void prefetch();
    const provider = (wikiRootDisplay) => {
        const header = `${FALLBACK_CORE}\n\nWiki root: ${wikiRootDisplay}\nTools: wiki_search · wiki_inspect · wiki_source_save · wiki_mutate · wiki_lint`;
        if (!cache.loaded || cache.playbooks.length !== PLAYBOOK_FILES.length)
            return header;
        return `${header}\n\n${cache.playbooks.join('\n\n')}`;
    };
    return { provider, prefetch };
}
//# sourceMappingURL=prompt.js.map