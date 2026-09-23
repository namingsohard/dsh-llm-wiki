# DSH-Wiki · Incremental Mutation

Wiki updates are minimal diffs via `wiki_mutate`, never whole-wiki rewrites:

- create — a genuinely new page. Requires `admission` scores (see extraction);
  the controller rejects weak candidates. id is an optional slug hint, else
  derived from the title. Link related pages in the same call (`"target"` or
  `"target | relation"`), and reference the `sources` ids you saved.
- update — new detail about an existing page: replace `body` with the full
  revised text, or add only `tags` / `links` / `sources` (those merge, never
  replace). Inspect the page first; preserve its structure and voice.
- merge — two pages describe one thing: the weaker id becomes a redirect
  stub (`status: merged`) and its tags/sources move to the survivor.
- link — record a relation discovered while working. Relations live on the
  source page's `links`.
- deprecate — knowledge that no longer holds. Keep the page for history,
  point `superseded_by` at the replacement. Never delete.

Rules of the layer:
- One page per concept. Prefer UPDATE over CREATE, LINK over prose duplication.
- Every claim a source can support should carry that source id.
- Body markdown: definition first, then key points, then "Related" links
  section. Chinese or English — whatever the task's language is; keep page
  ids lowercase ASCII slugs.
- Batch a task's mutations in ONE `wiki_mutate` call; each operation reports
  applied / noop / rejected / error independently.
