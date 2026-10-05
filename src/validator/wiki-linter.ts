import type { LintIssue } from '../types.js';
import type { WikiConfig } from '../config.js';
import type { ParseFailure, WikiStore } from '../storage/markdown-store.js';
import { WikiGraph } from '../graph/graph.js';
import { corpusOrder, graphOptionsOf, runChecks } from './checks.js';

/**
 * Wiki Linter: long-term quality maintenance for the knowledge layer.
 * Deterministic checks — duplicate pages, broken links, stale knowledge,
 * orphan pages, references to deprecated/merged pages, uncited source cards,
 * and oversize pages. The checks themselves live in `validator/checks.ts`,
 * shared with the mutation engine so a defect is named at write time as well.
 *
 * Report-only by design: fixes are knowledge decisions and go back through
 * the mutation pipeline (`wiki_mutate`).
 *
 * @module dsh-llm-wiki/validator/wiki-linter
 */

export interface LintReport {
  issues: LintIssue[];
  counts: { warn: number; info: number };
  scanned: number;
  parseFailures: ParseFailure[];
}

/** Sort: warnings first, then by check and page. */
function sortIssues(issues: LintIssue[]): LintIssue[] {
  return issues.sort((a, b) => (a.level === b.level ? a.check.localeCompare(b.check) || a.page.localeCompare(b.page) : a.level === 'warn' ? -1 : 1));
}

/** Run all lint checks over the wiki. */
export async function lintWiki(store: WikiStore, config: WikiConfig): Promise<LintReport> {
  const { pages, failures } = await store.listPages(['concept', 'entity', 'source']);
  const graph = WikiGraph.fromPages(pages, graphOptionsOf(config));
  const issues = runChecks({ graph, config, order: corpusOrder(pages) }, pages);
  sortIssues(issues);
  const warn = issues.filter((issue) => issue.level === 'warn').length;
  return { issues, counts: { warn, info: issues.length - warn }, scanned: pages.length, parseFailures: failures };
}

/** The graph the linter saw, for callers that want its shape (browser, stats). */
export async function lintGraph(store: WikiStore, config: WikiConfig): Promise<WikiGraph> {
  const { pages } = await store.listPages(['concept', 'entity', 'source']);
  return WikiGraph.fromPages(pages, graphOptionsOf(config));
}
