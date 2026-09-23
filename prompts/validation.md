# DSH-Wiki · Validation & Hygiene

Run `wiki_lint` after batches of mutations, and occasionally when starting
research-heavy work. Checks: duplicate pages, broken links, stale knowledge,
orphan pages, links to deprecated/merged pages, oversize pages.

Fixing findings goes through `wiki_mutate` (the linter never edits):

- duplicate → `merge` the weaker page into the stronger one.
- broken-link → fix the target id, or create the missing page if it is real
  knowledge, or drop the link via update if speculative.
- stale → verify against a current source, then `update` (fresh evidence) or
  `deprecate` (no longer true). Update refreshes the freshness clock only
  when content actually changed.
- orphan → add an inbound LINK from a natural parent page.
- oversize → split into two linked pages.

Keep the wiki trustworthy: it is only useful if the agent can reuse pages
without re-verifying everything. When a lint fix requires knowledge you do
not have, leave it for the next task rather than guessing.
