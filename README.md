# dsh-llm-wiki — DSH-Wiki: Agent Semantic Memory Plugin

English | [简体中文](README.zh-CN.md)

DSH-Wiki gives a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent a **long-term semantic memory**: a file-based Markdown wiki where knowledge gained from web searches, document reading, and task work is distilled once and reused across every future session.

```
Search → Understand → Abstract → Store → Reuse → Update
```

## Why

Every web search an agent runs is thrown away when the session ends. The next session re-searches, re-reads, re-pays. DSH-Wiki closes that loop:

| Layer | What lives there | On disk |
| --- | --- | --- |
| **Source Layer** | raw material: fetched pages, documents, quotes | `~/.dsh/wiki/sources/` |
| **Wiki Layer** | distilled knowledge: concepts, entities, relations | `~/.dsh/wiki/concepts/`, `entities/` |

`~/.dsh/wiki/index.md` is a generated table of contents; every mutation is journaled to `~/.dsh/wiki/logs/`.

## How it works

The plugin adds five model-facing tools plus a system-prompt playbook. The agent (the LLM) performs extraction and mutation analysis; the plugin makes the process **structured, incremental, and auditable**:

| Tool | Role |
| --- | --- |
| `wiki_search` | ranked retrieval **plus the Knowledge Router verdict** (`coverage`, `use_wiki`, `need_web`, `advice`) — the wiki-first / web-fallback decision |
| `wiki_inspect` | full page: frontmatter, body, inbound links, resolved sources |
| `wiki_source_save` | persist raw material with URL + retrieval time; content-hash dedup |
| `wiki_mutate` | batched incremental mutations: `create` / `update` / `merge` / `link` / `deprecate` |
| `wiki_lint` | duplicate / broken-link / stale / orphan / deprecated-ref / oversize checks |

Key mechanisms:

- **Source–Wiki separation.** Wiki claims reference `sources:` ids; knowledge stays traceable to evidence.
- **Admission Controller.** Every `create` must argue `reusability / stability / novelty / abstraction` (0..3 each). Transient events and one-off facts are rejected and journaled — the wiki does not become a log dump.
- **Incremental Mutation.** Minimal diffs beat rewrites: `update` merges tags/links/sources, `merge` leaves redirect stubs, `deprecate` keeps history. Nothing is deleted.
- **Knowledge Router.** Deterministic coverage scoring (token/phrase match + freshness) keeps the agent from re-fetching what the wiki already knows, and tells it exactly when to go to the web.
- **Freshness.** Pages age through `fresh → aging → stale`; stale top hits downgrade the router verdict so time-sensitive claims get verified.
- **Playbooks.** `prompts/*.md` ship as system-prompt guidance and are editable per deployment without a rebuild.

## Installation

DSH never builds a plugin: it loads the built entry declared in `package.json` (`main: ./lib/index.js`). This repository commits `lib/`, so every path below works without a build step.

### DSH Desktop (GUI)

Settings → Plugins → add one of:

- a tarball: `pnpm pack` here, then pick `dsh-llm-wiki-<version>.tgz`;
- an absolute path to a local checkout (`file:D:/WORKSPACE/dsh-llm-wiki-plugin`);
- a GitHub spec once published: `github:<owner>/dsh-llm-wiki#v0.1.0`.

Restart DSH Desktop.

### CLI profiles (`dsh web`, `headless`, …)

```powershell
dsh plugin --profile web add D:/path/to/dsh-llm-wiki-0.1.0.tgz   # tarball
dsh plugin --profile web add 'github:<owner>/dsh-llm-wiki#v0.1.0' # or git
dsh --profile web --dump-config | Select-String wiki -Context 1,2
```

Expect a `# == dsh-llm-wiki` layer containing `- id: wiki`. Then restart the app.

### Verify

Start a session and ask: *"What does the wiki know about X?"* A working install calls `wiki_search` and reports `coverage: none` on a fresh wiki. The wiki skeleton (`index.md`, `concepts/`, …) appears under `~/.dsh/wiki` on first start.

## Configuration

Optional, under the `wiki` key in `~/.dsh/settings.yaml` (all fields shown with defaults):

```yaml
wiki:
  wikiRoot: ""                # empty = $DSH_WIKI_ROOT > $DSH_HOME/wiki > ~/.dsh/wiki (`~` expands)
  searchLimit: 8              # default wiki_search hits
  includeSourcesInSearch: false
  agingAfterDays: 90          # freshness buckets
  staleAfterDays: 365
  admissionMinAverage: 1.75   # CREATE gate: mean of the four scores
  admissionMinIndividual: 1   # CREATE gate: per-dimension floor
  maxPageBytes: 65536
  maxSourceBytes: 262144      # source content cap (excess truncated)
  maxInspectBytes: 24576
  lintOrphans: true
  mutationLog: true
```

## Project layout

```
src/
├── index.ts                  plugin entry: name / inject / Config / apply
├── config.ts                 Schemastery config + wiki-root resolution
├── prompt.ts                 system-prompt section builder (loads prompts/*.md)
├── storage/
│   ├── id-slug.ts            traversal-proof page ids
│   ├── page-format.ts        canonical frontmatter parser/serializer
│   └── markdown-store.ts     atomic file storage, index, journal
├── retrieval/
│   ├── freshness.ts          fresh / aging / stale
│   └── grep-retriever.ts     phase-1 keyword retriever (CJK-aware)
├── router/knowledge-router.ts  coverage verdict: reuse vs acquire
├── mutation/
│   ├── admission.ts          Admission Controller
│   └── mutator.ts            CREATE / UPDATE / MERGE / LINK / DEPRECATE
├── validator/wiki-linter.ts  duplicate / broken-link / stale / orphan
└── tools/wiki-tools.ts       the five model-facing tools
prompts/                      router / extraction / mutation / validation playbooks
test/                         vitest suites (storage, retrieval, mutation, linter, tools)
```

## Development

```bash
pnpm install
pnpm build        # tsc -> lib/ (committed; DSH loads it directly)
pnpm typecheck
pnpm test         # vitest, 58 tests
pnpm smoke        # end-to-end knowledge loop on the built artifact
```

Design notes:

- **Zero runtime dependencies** beyond `@deepseek-ai/schemastery` (the settings schema); retrieval is deliberately grep-grade in phase 1 — a BM25/embedding retriever can replace `grep-retriever.ts` without touching tool contracts.
- All writes are atomic (temp + rename) and serialized; page ids are slug-validated so no call can escape the wiki root.
- The plugin treats the agent as the extractor and the store as the judge: prompts guide, code enforces.

## License

MIT
