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

The write gate (`wiki.approval`, default `staging`):
- A gated call answers `staged` per op and writes nothing live. Read back
  `staged_as` — that pending id is what later gets promoted.
- Fill `why` (1-2 sentences) on every op and on `wiki_source_save`. It is the
  only argument the user sees besides the rendered diff, so make it the reason
  this belongs in memory: what it saves next time, and where it came from.
- Before ending a turn that proposed anything, call `wiki_review({action:
  "list"})`, show the proposals with their reasons, and call `wiki_review` to
  put them to the user. Promoted ops then run through admission again; a page
  whose source was promoted in the same review grounds correctly.
- The user may approve part of a batch: pass their picks as `wiki_review({ids})`.
- A refusal is a decision, not a pause: declining the prompt (or a prompt that is
  cancelled at the turn boundary) **discards** the proposals it covered, so they
  never ride into a later review next to unrelated material. Do not re-propose
  that content unless it is genuinely needed again — re-deriving it is one web
  search away.
- `approval: "off"` applies ops directly and the results read `applied` as
  before.
