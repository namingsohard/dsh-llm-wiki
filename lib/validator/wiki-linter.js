import { WikiGraph } from '../graph/graph.js';
import { corpusOrder, graphOptionsOf, runChecks } from './checks.js';
/** Sort: warnings first, then by check and page. */
function sortIssues(issues) {
    return issues.sort((a, b) => (a.level === b.level ? a.check.localeCompare(b.check) || a.page.localeCompare(b.page) : a.level === 'warn' ? -1 : 1));
}
/** Run all lint checks over the wiki. */
export async function lintWiki(store, config) {
    const { pages, failures } = await store.listPages(['concept', 'entity', 'source']);
    const graph = WikiGraph.fromPages(pages, graphOptionsOf(config));
    const issues = runChecks({ graph, config, order: corpusOrder(pages) }, pages);
    sortIssues(issues);
    const warn = issues.filter((issue) => issue.level === 'warn').length;
    return { issues, counts: { warn, info: issues.length - warn }, scanned: pages.length, parseFailures: failures };
}
/** The graph the linter saw, for callers that want its shape (browser, stats). */
export async function lintGraph(store, config) {
    const { pages } = await store.listPages(['concept', 'entity', 'source']);
    return WikiGraph.fromPages(pages, graphOptionsOf(config));
}
//# sourceMappingURL=wiki-linter.js.map