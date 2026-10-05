# DSH-Wiki · Validation & Hygiene

Run `wiki_lint` after batches of mutations, and occasionally when starting
research-heavy work. Checks: duplicate pages, broken links (a `[[id]]` mention
counts when `wiki.wikiLinkEdges` is on), stale knowledge, orphan pages, links to
deprecated/merged pages, source cards nobody cites, oversize pages.

A batch already reports these same checks for the pages it touched
(`wiki_mutate` → `graph.findings`), so the corpus sweep is for what you did not
just write — and for confirming a fix actually landed.

Fixing findings goes through `wiki_mutate` (the linter never edits):

- duplicate → `merge` the weaker page into the stronger one.
- broken-link → fix the target id, or create the missing page if it is real
  knowledge, or drop the link via update if speculative.
- stale → verify against a current source, then `update` (fresh evidence) or
  `deprecate` (no longer true). Update refreshes the freshness clock only
  when content actually changed.
- orphan → add an inbound LINK from a natural parent page. `wiki_inspect` lists
  `candidate_links` for that page: judge them, then link the real ones. An
  orphan is not a defect to silence — linking from a page that does not really
  relate just hides the finding.
- unreferenced-source → the card was saved and never used. Cite it on the page
  it actually grounded, or accept that it was saved for nothing.
- oversize → split into two linked pages.

Reading the graph, when a finding is about connectivity rather than content:
`wiki_inspect` answers "is this page wired in?" (`backlinks` with their
relations, `dangling`, `candidate_links`), and the sidebar reader shows the same
under the page. Edges live in frontmatter `links:` — nothing else stores them,
so a page you can reason about is a page you can always re-derive.

Keep the wiki trustworthy: it is only useful if the agent can reuse pages
without re-verifying everything. When a lint fix requires knowledge you do
not have, leave it for the next task rather than guessing.
