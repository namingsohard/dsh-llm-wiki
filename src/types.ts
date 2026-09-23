/**
 * Domain types shared by the DSH-Wiki plugin modules.
 *
 * The wiki is a file-based semantic memory layer: a Source Layer of raw
 * material and a Wiki Layer of structured knowledge (concepts, entities,
 * relations). Pages are Markdown files with a constrained frontmatter.
 *
 * @module dsh-llm-wiki/types
 */

/** Page classes. `source` is the raw-material layer; the others form the wiki layer. */
export type PageKind = 'concept' | 'entity' | 'source';

/** Lifecycle of a page. Merged pages remain as redirect stubs (history preservation). */
export type PageStatus = 'active' | 'deprecated' | 'merged';

/** Freshness bucket derived from the page's `updated` timestamp. */
export type Freshness = 'fresh' | 'aging' | 'stale';

/** A directed relation from one page to another, optionally labelled. */
export interface WikiLink {
  /** Target page id. */
  target: string;
  /** Optional human-readable relation label. */
  relation?: string;
}

/** Parsed frontmatter of a wiki page. */
export interface WikiPageMeta {
  /** Stable slug id, unique across the whole wiki. */
  id: string;
  kind: PageKind;
  title: string;
  status: PageStatus;
  /** Monotonic per-page revision, bumped on every applied mutation. */
  revision: number;
  /** ISO-8601 creation timestamp. */
  created: string;
  /** ISO-8601 last-mutation timestamp. */
  updated: string;
  tags: string[];
  links: WikiLink[];
  /** Source page ids this page is grounded in. */
  sources: string[];
  /** Origin URL for `source` pages. */
  url?: string;
  /** ISO-8601 retrieval timestamp for `source` pages. */
  obtained?: string;
  /** Id of the page that superseded this one (deprecated/merged pages). */
  supersededBy?: string;
}

/** A fully loaded page: frontmatter + Markdown body + on-disk location. */
export interface WikiPage extends WikiPageMeta {
  body: string;
  /** Absolute path of the backing file. */
  path: string;
}

/** One ranked hit from {@link grep-retriever}. */
export interface SearchHit {
  id: string;
  kind: PageKind;
  title: string;
  status: PageStatus;
  /** Relative relevance score; higher is better, always > 0 for returned hits. */
  score: number;
  freshness: Freshness;
  /** Text window around the strongest match. */
  snippet: string;
  updated: string;
}

/** How well the existing wiki covers a query; drives the Knowledge Router. */
export type Coverage = 'none' | 'low' | 'partial' | 'high';

/** Router verdict returned alongside every `wiki_search`. */
export interface RouterDecision {
  coverage: Coverage;
  /** Reuse wiki content directly (high) or after inspection (partial). */
  useWiki: boolean;
  /** Fall back to external acquisition (web search / document reading). */
  needWeb: boolean;
  /** One-sentence guidance rendered for the model. */
  advice: string;
  /** Top hit, when any. */
  topHit?: SearchHit;
}

/** Admission scores for a candidate knowledge item, each 0..3. */
export interface AdmissionScores {
  reusability: number;
  stability: number;
  novelty: number;
  abstraction: number;
}

/** Verdict of the Admission Controller. */
export interface AdmissionVerdict {
  accept: boolean;
  average: number;
  minimum: number;
  reasons: string[];
}

/** One operation of the Mutation Engine (see {@link mutator}). */
export interface MutationOp {
  op: 'create' | 'update' | 'merge' | 'link' | 'deprecate';
  /** Target id (create: optional slug hint; update/link/deprecate: subject). */
  id?: string;
  kind?: 'concept' | 'entity';
  title?: string;
  body?: string;
  status?: PageStatus;
  tags?: string[];
  /** Link entries: `"target"` or `"target | relation"`. */
  links?: string[];
  sources?: string[];
  /** merge: destination id. */
  into_id?: string;
  /** link: destination id. */
  to_id?: string;
  /** link: relation label. */
  relation?: string;
  /** deprecate: why the page no longer holds. */
  reason?: string;
  /** deprecate: id of the replacement page. */
  superseded_by?: string;
  /** create: admission scores (required for CREATE). */
  admission?: AdmissionScores;
  /** Free-form note recorded in the mutation log. */
  note?: string;
}

/** Outcome of one applied operation. */
export interface MutationResult {
  index: number;
  op: MutationOp['op'];
  id: string;
  status: 'applied' | 'rejected' | 'noop' | 'error';
  detail?: string;
}

/** A line in `logs/YYYY-MM-DD.jsonl`. */
export interface LogEntry {
  ts: string;
  op: string;
  pages: string[];
  result: string;
  note?: string;
}

/** One finding from the Wiki Linter. */
export interface LintIssue {
  check: 'duplicate' | 'broken-link' | 'stale' | 'orphan' | 'deprecated-ref' | 'oversize';
  level: 'info' | 'warn';
  page: string;
  message: string;
}
