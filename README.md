# DSH-Wiki — Agent Semantic Memory for DeepSeek Harness

[English](README.md) | [简体中文](README.zh-CN.md)

DSH-Wiki gives a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent **long-term semantic memory**: a file-based Markdown wiki where knowledge gained from web searches, document reading, and task work is distilled once and reused across every future session.

```
Search → Understand → Abstract → Store → Reuse → Update
```

The design follows Andrej Karpathy's ["LLM Wiki"](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern — the LLM maintains a persistent, interlinked Markdown wiki instead of re-deriving knowledge from raw documents at query time — adapted to a harness plugin with a user-approved write gate.

## Highlights

- **Two layers.** A *Source Layer* of provenance cards (title + URL + date, never the page text) and a *Wiki Layer* of distilled concepts and entities under `~/.dsh/wiki/`.
- **Seven tools + a compact prompt section.** `wiki_search`, `wiki_inspect`, `wiki_source_save`, `wiki_mutate`, `wiki_review`, `wiki_lint`, `wiki_guide`.
- **Write gate.** Default `approval: staging`: proposals land in `<wiki>/staging/` with a rendered pitch; `wiki_review` puts them in front of you, and nothing is live until you approve. Declining a review discards the proposals it covered — the queue does not quietly accumulate.
- **Admission Controller.** Every `create` must score `reusability / stability / novelty / abstraction`; transient facts are refused at proposal time, so the wiki never becomes a log dump.
- **Incremental mutation.** `create / update / merge / link / deprecate` with minimal diffs; merges leave redirect stubs; nothing is deleted.
- **Self-maintaining link graph.** Pages are nodes, frontmatter `links:` are edges — derived, never stored. Every write answers with what it did to the shape of the wiki: dangling edges on the pages it touched, corpus counts (edges / dangling / orphans / isolated), the same lint checks scoped to those pages, and candidate links nominated for them. The plugin nominates; only you write an edge.
- **Knowledge Router.** Deterministic coverage verdicts (`none / low / partial / high`) with per-hit match evidence: reuse the wiki when it is covered, go to the web when it is not.
- **Web-access nudge.** A turn that browsed the web without touching the wiki gets one reminder folded into the *next step's input* — the turn is never extended.
- **Sidebar browser.** On hosts with a web surface, a read-only "Wiki memory" tab on the right Sidebar (tree, page reader, staged proposals).
- **Zero runtime dependencies** beyond the settings schema; retrieval is CJK-aware keyword search, swappable for BM25/embeddings without touching tool contracts.

## Installation

DSH never builds a plugin: it loads the built entry declared in `package.json` (`main: ./lib/index.js`). This repository commits `lib/`, so every path below works without a build step.

**DSH Desktop (GUI):** Settings → Plugins → add `github:namingsohard/dsh-llm-wiki` (append `#<tag>` to pin a release). Offline, `pnpm pack` in a checkout and pick the generated `dsh-llm-wiki-<version>.tgz`. Restart DSH Desktop.

**CLI profiles** (`dsh web`, `headless`, …):

```powershell
dsh plugin --profile web add 'github:namingsohard/dsh-llm-wiki'
dsh --profile web --dump-config | Select-String wiki -Context 1,2
```

Expect a `# == dsh-llm-wiki` layer containing `- id: wiki`. Then restart the app.

**Verify:** start a session and ask *"What does the wiki know about X?"* A working install calls `wiki_search` and reports `coverage: none` on a fresh wiki; the skeleton (`index.md`, `concepts/`, …) appears under `~/.dsh/wiki` on first start.

## Host compatibility

Checked against **dsh 0.1.5-rc.1 through 0.2.1-alpha.1**. Whether a host loads this plugin at all is decided by `dsh-app-boot`: it takes every `@deepseek-ai/dsh*` key in `peerDependencies` and runs `semver.satisfies(hostVersion, range, { includePrerelease: true })`. One miss and the bundle is skipped — `Plugin dsh-llm-wiki@… is incompatible with dsh …` in the host log, and the plugin row disabled — with nothing else to explain why the tools never appeared. That is why the ranges are an explicit `||` list of releases this plugin has actually been run against, rather than a caret over versions nobody has tested: an honest "not yet" beats a silent claim. (0.2.x hosts additionally accept an exact-version exemption via `dsh plugin allow-version` / the profile's `compatibility.json`; reaching for it instead of widening the list above is how a plugin ends up running on a host nobody checked.)

| host line | versions | note |
| --- | --- | --- |
| 0.1.5-rc.1 → 0.1.6-alpha.2 | rc.1, rc.2, rc.3, alpha.1, alpha.2 | session format **v3** |
| 0.1.7-alpha.1 → 0.1.7-rc.2 | alpha.1, alpha.2, rc.1, rc.2 | session format **v4** |
| 0.2.0-rc.1 → 0.2.1-alpha.1 | rc.1, rc.2, alpha.1 | session format **v4**; no seam changes — the gate, the events, and the seats below are byte-identical to 0.1.7-rc.2 |

What 0.1.7 changed for a plugin like this one, and what the code does about it (all still true on 0.2.x):

- **Session format v4** retired the `{ kind: 'plugin', plugin: <name> }` message source: appending one is refused with *"format v4 message requires a producer-owned source kind"*, and the v3→v4 migration rewrites old rows of unknown producers to `plugin:<name>`. The nudge therefore signs its reminder as `plugin:dsh-llm-wiki` — valid on v4, valid on v3 (which only requires a non-empty `kind`), and identical to what its own pre-v4 reminders become after migration.
- **Observation moved off the waterfall.** The turn counters now ride `tools/result` (an emit over the frozen outcome, listener failures contained by the harness) instead of `tools/post-execute`, so a wiki observer can never sit in the path of a tool decision. Folded `agent/pre-step` decisions are spread rather than rebuilt, so decision fields newer than this plugin survive.

Everything else this plugin touches — `defineTool`, the `user-approval` request shape, `agent/pre-step`, `webServer.register`, `ctx.get('connection', false).requestRejection`, the sidebar-right tab seats, the client manifest — is declared identically across the whole range. `test/compat.test.ts` fails if the manifest and the tested list drift apart; adding a host release means appending it there and to both peer ranges.

## Configuration

Optional, under the `wiki` key in `~/.dsh/settings.yaml` (defaults shown):

```yaml
wiki:
  wikiRoot: ""                # empty = $DSH_WIKI_ROOT > $DSH_HOME/wiki > ~/.dsh/wiki
  searchLimit: 8              # default wiki_search hits
  includeSourcesInSearch: false
  agingAfterDays: 90          # freshness buckets: fresh → aging → stale
  staleAfterDays: 365
  admissionMinAverage: 1.75   # CREATE gate: mean of the four scores
  admissionMinIndividual: 1   # CREATE gate: per-dimension floor
  maxPageBytes: 65536
  maxInspectBytes: 24576
  lintOrphans: true
  mutationLog: true
  approval: staging           # staging | inline | off
  maxStagedBytes: 65536       # per-proposal cap; oversized bodies are refused
  nudge: next-step            # next-step | off
  # link graph
  linkTargetCheck: warn       # warn | strict | off — a link to a page that does not exist
  linkSuggest: true           # nominate candidate links for a page being written
  linkSuggestLimit: 5         # candidates per touched page
  linkSuggestMinScore: 2      # floor on the wiki_search score scale
  sourceEdges: true           # treat "sources:" as provenance edges of the graph
  wikiLinkEdges: false        # derive edges from [[page-id]] mentions (changes lint output)
  graphExpansion: false       # append one-hop neighbours to wiki_search as `related`
  graphExpansionLimit: 3
```

## The link graph

A wiki is a graph, and this one needs no separate store: the edges are the `links:` entries in each page's frontmatter (`"target"` or `"target | relation"`), plus — when you turn them on — `[[page-id]]` mentions in a body and the `sources:` refs that ground a page. Everything else (backlinks, dangling edges, orphans, neighbour nominations) is computed from those pages, so it can never drift out of sync and no migration can corrupt it.

What the plugin then does with it, all deterministically and with no model call in the write path:

| where | what it says |
| --- | --- |
| `wiki_mutate` → `graph` | what this batch did to the graph: corpus counts, the dangling edges it introduced, the scoped lint findings, and `suggestions` — candidate links with the shared terms that earned them. Also filled for a batch the write gate is only *proposing* (`preview: true`), so a doomed edge is named before you approve it. |
| `wiki_inspect` | `backlinks` with their relations, `dangling` edges of this page, `candidate_links`, and `referenced_by` for a source card. |
| `wiki_lint` | the same checks as a corpus sweep, plus `unreferenced-source`: a card nobody cites was saved for nothing. |
| `wiki_search` | optionally `related`: one-hop neighbours of the hits, marked with the edge that reached them. Never counted as coverage — a neighbour is context, not an answer. |
| sidebar reader | the same picture under the page: what it claims, what claims it, dead edges, candidates, and `[[id]]` mentions as live links. |

Two rules hold the design in shape. **Nomination is not writing**: an auto-linked page stops looking like an orphan, so an automatic edge disarms exactly the check that tells you a page is unreachable — and it asserts a relation nobody verified. **An edge to nothing is a defect worth naming**: by default a write applies and says so; set `linkTargetCheck: strict` to hold the wiki to "no edge points at nothing" (ids created by the same batch count as existing, so a linked cluster can still land in one call).

## Privilege boundary

The wiki lives at `~/.dsh/wiki` by default — **outside the session workspace** — and the plugin writes it with plain `node:fs` calls inside the harness process, so the DSH file sandbox (`read-only` / `workspace-write` / `danger-full-access`) does not gate these writes. Two things hold the line instead: page and staging ids are slug-validated (`/^[a-z0-9][a-z0-9._-]{0,79}$/`), so no tool call can escape the wiki root; and the write gate means nothing reaches the wiki layers without passing admission and, by default, your approval.

## Project layout

```
src/
├── index.ts                  plugin entry: name / inject / Config / apply
├── config.ts                 Schemastery config + wiki-root resolution
├── prompt.ts                 compact resident prompt + on-demand playbook reader
├── storage/                  page format, atomic markdown store, staging area
├── retrieval/                freshness buckets + CJK-aware keyword retriever
├── router/                   coverage verdict: reuse the wiki or go acquire
├── graph/                    derived link graph + neighbour nomination
├── mutation/                 admission, review pitches, the five ops
├── browser/                  read-only /wiki/* routes for the sidebar browser
├── validator/                lint: duplicates, broken links, stale, orphans
├── hooks/                    web-access nudge
└── tools/                    the seven model-facing tools
client/wiki-client.js         hand-written browser bundle (sidebar Wiki tab)
prompts/                      router / extraction / mutation / validation playbooks
test/                         vitest suites (176 tests, incl. the host-compatibility contract)
```

Deep design notes (why link-only sources, why the resident prompt is byte-stable, why the nudge rides the next step) live in `DSH-Wiki_Project_Blueprint.md` and the playbooks under `prompts/`.

## Development

```bash
pnpm install
pnpm build        # tsc -> lib/ (committed; DSH loads it directly)
pnpm typecheck
pnpm test         # vitest, 176 tests
pnpm smoke        # end-to-end passes against the built artifact
pnpm prompt:size  # guard the resident-prompt byte budget
```

`pnpm-workspace.yaml` pins `nodeLinker: hoisted`. The harness `import()`s `lib/index.js` from outside this tree, and `pnpm smoke` does the same; the default isolated layout hides the harness peers behind junctions Node's ESM resolver will not walk back out of, so a flat tree is what makes the built artifact loadable the way the host loads it.

## References

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the host this plugin extends.
- Andrej Karpathy, [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — the source-layer/wiki-layer/schema pattern this plugin implements; itself in the lineage of Vannevar Bush's Memex (1945).

## License

MIT
