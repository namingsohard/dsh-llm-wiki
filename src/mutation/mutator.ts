import type { LintIssue, LogEntry, MutationOp, MutationResult, PageKind, WikiLink, WikiPage } from '../types.js';
import type { WikiConfig } from '../config.js';
import { assertPageId, isValidPageId, slugifyTitle } from '../storage/id-slug.js';
import type { WikiStore } from '../storage/markdown-store.js';
import { assertAdmissionScores, evaluateAdmission } from './admission.js';
import { WikiGraph, type DanglingEdge, type GraphStats } from '../graph/graph.js';
import { graphOptionsOf, checksFor } from '../validator/checks.js';
import { suggestNeighbors, type NeighborSuggestion, type SuggestionSubject } from '../graph/suggest.js';

/**
 * Mutation Engine: applies incremental knowledge mutations to the wiki —
 * CREATE / UPDATE / MERGE / LINK / DEPRECATE — instead of rewriting pages.
 * CREATE passes through the Admission Controller; every outcome (applied,
 * rejected, error) is journaled so the update history stays auditable.
 *
 * Graph maintenance rides on the same seam. A batch is where a page gains
 * edges, so it is also where a missing edge is still cheap to notice: after the
 * writes land, the engine re-reads the corpus, rebuilds the derived graph, and
 * reports what the batch did to the link structure — dangling edges, the same
 * scoped lint findings `wiki_lint` would produce, and nominated links for the
 * pages it touched. Nominating is all it does; an edge stays a decision.
 *
 * Concurrency: mutations route through the store's in-process lock; page
 * revisions make lost updates detectable by the linter, not silently merged.
 *
 * @module dsh-llm-wiki/mutation/mutator
 */

/** What the batch changed about the graph, and what it still leaves open. */
export interface GraphFeedback {
  /** Corpus shape (whole wiki, not just the batch). */
  stats: GraphStats;
  /** Edges the touched pages declare toward pages that do not exist. */
  dangling: DanglingEdge[];
  /** Candidate links per touched wiki-layer page. Nominations: nothing here is written. */
  suggestions: { id: string; candidates: NeighborSuggestion[] }[];
  /** `wiki_lint` checks over the touched pages only. */
  findings: LintIssue[];
  /** Advice worth stating in words (a page that gained no edge, a target to fix). */
  notes: string[];
  /** True when this feedback describes a proposal, not a applied write. */
  preview: boolean;
}

export interface MutateOutcome {
  results: MutationResult[];
  applied: number;
  rejected: number;
  indexRebuilt: boolean;
  /** Graph feedback for the batch, when graph reporting is enabled. */
  graph: GraphFeedback;
}

/** Ids a write may point at: what is on disk, plus what this batch creates. */
class WriteScope {
  private readonly known: Set<string>;
  private readonly promised: Set<string>;

  constructor(known: Iterable<string>, promised: Iterable<string>) {
    this.known = new Set(known);
    this.promised = new Set(promised);
  }

  exists(id: string): boolean {
    return this.known.has(id) || this.promised.has(id);
  }

  /** Declared targets no page answers, now or by the end of this batch. */
  missing(links: readonly WikiLink[]): WikiLink[] {
    return links.filter((link) => !this.exists(link.target));
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseLinkEntries(entries: readonly string[], selfId: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const raw of entries) {
    const text = raw.trim();
    if (text.length === 0) continue;
    const bar = text.indexOf('|');
    const target = (bar < 0 ? text : text.slice(0, bar)).trim();
    const relation = bar < 0 ? undefined : text.slice(bar + 1).trim();
    if (!isValidPageId(target)) throw new Error(`bad link target ${JSON.stringify(target)}`);
    if (target === selfId) throw new Error(`page ${selfId} cannot link to itself`);
    const link: WikiLink = { target };
    if (relation !== undefined && relation.length > 0) link.relation = relation;
    out.push(link);
  }
  return out;
}

function sameLink(a: WikiLink, b: WikiLink): boolean {
  return a.target === b.target && (a.relation ?? '') === (b.relation ?? '');
}

function unionLinks(existing: readonly WikiLink[], added: readonly WikiLink[]): WikiLink[] {
  const out = [...existing];
  for (const link of added) if (!out.some((e) => sameLink(e, link))) out.push(link);
  return out;
}

function unionList(existing: readonly string[], added: readonly string[]): string[] {
  return [...new Set([...existing, ...added])].sort();
}

function textValue(raw: unknown, field: string, required: boolean): string | undefined {
  if (raw === undefined || raw === null) {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (typeof raw !== 'string') throw new Error(`${field} must be a string`);
  return raw;
}

/** The id a create op will land on, or undefined when the op cannot be named yet. */
function createdId(op: MutationOp): string | undefined {
  if (op.op !== 'create') return undefined;
  if (op.id !== undefined) return op.id;
  if (typeof op.title !== 'string' || op.title.trim().length === 0) return undefined;
  return slugifyTitle(op.title);
}

function describeLinks(links: readonly WikiLink[]): string {
  return links.map((link) => (link.relation === undefined ? `"${link.target}"` : `"${link.target}" (${link.relation})`)).join(', ');
}

export class Mutator {
  private readonly store: WikiStore;
  private readonly config: WikiConfig;

  constructor(store: WikiStore, config: WikiConfig) {
    this.store = store;
    this.config = config;
  }

  /** Apply a batch of operations. One bad operation fails only itself. */
  async apply(ops: readonly MutationOp[]): Promise<MutateOutcome> {
    return await this.store.withLock(async () => {
      const promised = new Set<string>();
      for (const raw of ops) {
        const id = createdId(raw as MutationOp);
        if (id !== undefined) promised.add(id);
      }
      const onDisk = await this.store.listIds();

      const results: MutationResult[] = [];
      const entries: LogEntry[] = [];
      const touched = new Set<string>();
      let applied = 0;
      let rejected = 0;

      for (const [index, raw] of ops.entries()) {
        const op = raw as MutationOp;
        let result: MutationResult;
        try {
          result = await this.applyOne(op, index, entries, new WriteScope(onDisk.keys(), promised));
        } catch (error) {
          result = {
            index,
            op: op.op,
            id: op.id ?? 'unknown',
            status: 'error',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        results.push(result);
        if (result.status === 'applied') {
          applied++;
          for (const id of resultPages(op, result)) touched.add(id);
        }
        if (result.status === 'rejected' || result.status === 'error') rejected++;
      }

      let indexRebuilt = false;
      let pages: WikiPage[] = [];
      if (applied > 0) {
        pages = (await this.store.listPages()).pages;
        await this.store.rebuildIndex(pages);
        indexRebuilt = true;
      }
      if (this.config.mutationLog && entries.length > 0) await this.store.appendLog(entries);
      const graph = await this.graphOf(pages);
      const feedback = await this.feedback(graph, touched, false);
      return { results, applied, rejected, indexRebuilt, graph: feedback };
    });
  }

  /**
   * What the graph would look like if this batch were applied, without writing
   * anything. The write gate parks most batches in `staging/`, so the same
   * feedback has to be legible at proposal time too — an edge that will dangle
   * is worth naming before the user ever sees the pitch.
   */
  async previewGraph(ops: readonly MutationOp[]): Promise<GraphFeedback> {
    const graph = await this.graphOf();
    const promised = new Set<string>();
    for (const raw of ops) {
      const id = createdId(raw as MutationOp);
      if (id !== undefined) promised.add(id);
    }
    const scope = new WriteScope(graph.pages.map((page) => page.id), promised);
    const subjects: SuggestionSubject[] = [];
    const dangling: DanglingEdge[] = [];
    const notes: string[] = [];
    for (const raw of ops) {
      const op = raw as MutationOp;
      const id = createdId(op) ?? op.id;
      if (id === undefined) continue;
      if (op.links !== undefined) {
        let links: WikiLink[];
        try {
          links = parseLinkEntries(op.links, id);
        } catch {
          continue; // a malformed entry is the tool's error to report, not this one's
        }
        for (const link of scope.missing(links)) {
          const edge: DanglingEdge = { page: id, target: link.target, kind: 'link' };
          if (link.relation !== undefined) edge.relation = link.relation;
          dangling.push(edge);
        }
      }
      if (op.op === 'create' || op.op === 'update') {
        const existing = graph.get(id);
        subjects.push({
          id,
          title: op.title ?? existing?.title ?? id,
          tags: op.tags ?? existing?.tags ?? [],
          body: op.body ?? existing?.body ?? '',
        });
      }
    }
    const suggestions = this.suggestFor(graph, subjects);
    for (const edge of dangling) {
      notes.push(`${edge.page} links to "${edge.target}", which does not exist${this.config.linkTargetCheck === 'strict' ? ' — strict mode will refuse this write' : '; create the page or drop the link'}`);
    }
    for (const entry of suggestions) {
      if (entry.candidates.length === 0 && !graph.has(entry.id)) notes.push(`${entry.id} is a new page with no candidate neighbour yet — it starts life unlinked`);
    }
    return { stats: graph.stats(), dangling, suggestions, findings: [], notes, preview: true };
  }

  /** Rebuild the derived graph over the corpus (pass `pages` to reuse a listing). */
  async graphOf(pages?: readonly WikiPage[]): Promise<WikiGraph> {
    const loaded = pages ?? (await this.store.listPages()).pages;
    return WikiGraph.fromPages(loaded, graphOptionsOf(this.config));
  }

  /** Nominated links for one existing page, over a graph the caller already has. */
  suggestionsFor(page: WikiPage, graph: WikiGraph): NeighborSuggestion[] {
    if (page.kind === 'source') return [];
    return this.suggestFor(graph, [{ id: page.id, title: page.title, tags: page.tags, body: page.body }])[0]?.candidates ?? [];
  }

  private suggestFor(graph: WikiGraph, subjects: readonly SuggestionSubject[]): { id: string; candidates: NeighborSuggestion[] }[] {    if (!this.config.linkSuggest) return [];
    const out: { id: string; candidates: NeighborSuggestion[] }[] = [];
    for (const subject of subjects) {
      const candidates = suggestNeighbors(graph, subject, {
        limit: this.config.linkSuggestLimit,
        minScore: this.config.linkSuggestMinScore,
        agingAfterDays: this.config.agingAfterDays,
        staleAfterDays: this.config.staleAfterDays,
      });
      out.push({ id: subject.id, candidates });
    }
    return out;
  }

  /** Assemble the write-result graph feedback over a fresh graph. */
  private async feedback(graph: WikiGraph, touched: ReadonlySet<string>, preview: boolean): Promise<GraphFeedback> {
    const stats = graph.stats();
    if (touched.size === 0) return { stats, dangling: [], suggestions: [], findings: [], notes: [], preview };
    const touchedPages = graph.pages.filter((page) => touched.has(page.id));
    // `off` means the write path has no opinion about link targets at all.
    const dangling = this.config.linkTargetCheck === 'off' ? [] : graph.danglingEdges().filter((edge) => touched.has(edge.page));
    const findings = checksFor(graph, this.config, touchedPages);
    const subjects = touchedPages.filter((page) => page.kind !== 'source').map((page) => ({ id: page.id, title: page.title, tags: page.tags, body: page.body }));
    const suggestions = this.suggestFor(graph, subjects);
    const notes: string[] = [];
    for (const page of touchedPages) {
      if (page.kind === 'source' || page.status !== 'active') continue;
      if (graph.knowledgeOutbound(page.id) === 0) {
        notes.push(`${page.id} now has no outgoing edge: it is only reachable if something links to it`);
      }
      if (graph.knowledgeInbound(page.id) === 0 && suggestions.find((entry) => entry.id === page.id)?.candidates.length === 0) {
        notes.push(`${page.id} is not reachable from any page and no candidate neighbour scored — link it deliberately or merge it into one`);
      }
    }
    for (const edge of dangling) {
      notes.push(`${edge.page} links to "${edge.target}", which does not exist — create the page or drop the link`);
    }
    return { stats, dangling, suggestions, findings, notes, preview };
  }

  private log(entries: LogEntry[], op: MutationOp, pages: string[], result: string, detail?: string): void {
    const entry: LogEntry = { ts: nowIso(), op: op.op, pages, result };
    if (op.note !== undefined) entry.note = op.note;
    if (detail !== undefined) entry.note = entry.note === undefined ? detail : `${entry.note} — ${detail}`;
    entries.push(entry);
  }

  private async applyOne(op: MutationOp, index: number, entries: LogEntry[], scope: WriteScope): Promise<MutationResult> {
    switch (op.op) {
      case 'create':
        return await this.create(op, index, entries, scope);
      case 'update':
        return await this.update(op, index, entries, scope);
      case 'merge':
        return await this.merge(op, index, entries);
      case 'link':
        return await this.link(op, index, entries);
      case 'deprecate':
        return await this.deprecate(op, index, entries);
      default:
        return { index, op: op.op, id: op.id ?? 'unknown', status: 'error', detail: `unknown op ${JSON.stringify(op.op)}` };
    }
  }

  private checkBodySize(id: string, body: string): void {
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > this.config.maxPageBytes) {
      throw new Error(`page ${id} body is ${bytes} bytes, over maxPageBytes ${this.config.maxPageBytes}; split it or condense the text`);
    }
  }

  /**
   * The one standard for a link target, applied to every write path. `off`
   * stays silent; `warn` writes and lets the feedback name the hole; `strict`
   * refuses, so a wiki can be held to "no edge points at nothing".
   */
  private checkTargets(id: string, links: readonly WikiLink[], scope: WriteScope): string | undefined {
    if (this.config.linkTargetCheck === 'off') return undefined;
    const missing = scope.missing(links);
    if (missing.length === 0) return undefined;
    if (this.config.linkTargetCheck !== 'strict') return undefined;
    return `link target(s) do not exist: ${describeLinks(missing)}. Create the target first (ids made by this same batch do count), or drop the link. Set linkTargetCheck to "warn" to write anyway.`;
  }

  private async create(op: MutationOp, index: number, entries: LogEntry[], scope: WriteScope): Promise<MutationResult> {
    const title = textValue(op.title, 'title', true) as string;
    const body = textValue(op.body, 'body', true) as string;
    const kind: PageKind = op.kind === 'entity' ? 'entity' : 'concept';
    if (op.admission === undefined) {
      throw new Error('create requires admission scores: {reusability, stability, novelty, abstraction}, each 0..3');
    }
    const scores = assertAdmissionScores(op.admission);
    const verdict = evaluateAdmission(scores, this.config);
    const id = op.id ?? slugifyTitle(title);
    assertPageId(id);

    if (!verdict.accept) {
      this.log(entries, op, [id], 'rejected', `admission: ${verdict.reasons.join('; ')}`);
      return {
        index,
        op: 'create',
        id,
        status: 'rejected',
        detail: `admission rejected (${verdict.reasons.join('; ')}). If this belongs with an existing page, use update/merge instead.`,
      };
    }

    const existing = await this.store.read(id);
    if (existing !== undefined) {
      this.log(entries, op, [id], 'rejected', 'duplicate id');
      return {
        index,
        op: 'create',
        id,
        status: 'rejected',
        detail: `page "${id}" already exists ("${existing.title}"); use op "update" for incremental change instead of re-creating`,
      };
    }
    this.checkBodySize(id, body);
    const links = parseLinkEntries(op.links ?? [], id);
    const refused = this.checkTargets(id, links, scope);
    if (refused !== undefined) {
      this.log(entries, op, [id], 'rejected', refused);
      return { index, op: 'create', id, status: 'rejected', detail: refused };
    }

    const now = nowIso();
    const page: WikiPage = {
      id,
      kind,
      title,
      status: 'active',
      revision: 1,
      created: now,
      updated: now,
      tags: [...new Set(op.tags ?? [])].sort(),
      links,
      sources: [...new Set(op.sources ?? [])].sort(),
      body: body.trimEnd() + '\n',
      path: this.store.pagePath(kind, id),
    };
    for (const source of page.sources) assertPageId(source);
    await this.store.writePage(page);
    this.log(entries, op, [id], 'applied', `admission avg ${verdict.average}`);
    return { index, op: 'create', id, status: 'applied', detail: `created ${kind} page (revision 1, admission avg ${verdict.average})` };
  }

  private async update(op: MutationOp, index: number, entries: LogEntry[], scope: WriteScope): Promise<MutationResult> {
    const id = textValue(op.id, 'id', true) as string;
    assertPageId(id);
    const page = await this.store.read(id);
    if (page === undefined) return { index, op: 'update', id, status: 'error', detail: `no wiki page "${id}"` };

    const body = op.body !== undefined ? textValue(op.body, 'body', false) : undefined;
    if (op.body !== undefined && body === undefined) throw new Error('body must be a string');
    if (body !== undefined) this.checkBodySize(id, body);
    const title = op.title !== undefined ? (textValue(op.title, 'title', false) as string) : undefined;
    const addedLinks = op.links !== undefined ? parseLinkEntries(op.links, id) : [];
    const refused = this.checkTargets(id, unionLinks(page.links, addedLinks), scope);
    if (refused !== undefined) {
      this.log(entries, op, [id], 'rejected', refused);
      return { index, op: 'update', id, status: 'rejected', detail: refused };
    }

    const updated: WikiPage = {
      ...page,
      title: title ?? page.title,
      body: body !== undefined ? body.trimEnd() + '\n' : page.body,
      status: op.status ?? page.status,
      tags: op.tags !== undefined ? unionList(page.tags, op.tags) : page.tags,
      links: op.links !== undefined ? unionLinks(page.links, addedLinks) : page.links,
      sources: op.sources !== undefined ? unionList(page.sources, op.sources.map((s) => (assertPageId(s), s))) : page.sources,
      revision: page.revision + 1,
      updated: nowIso(),
    };
    if (
      updated.title === page.title &&
      updated.body === page.body &&
      updated.status === page.status &&
      updated.tags.length === page.tags.length &&
      updated.links.length === page.links.length &&
      updated.sources.length === page.sources.length
    ) {
      return { index, op: 'update', id, status: 'noop', detail: 'no field changed' };
    }
    await this.store.writePage(updated);
    this.log(entries, op, [id], 'applied', `revision ${page.revision} -> ${updated.revision}`);
    return { index, op: 'update', id, status: 'applied', detail: `revision ${page.revision} -> ${updated.revision}` };
  }

  private async merge(op: MutationOp, index: number, entries: LogEntry[]): Promise<MutationResult> {
    const fromId = textValue(op.id, 'id (source page to merge away)', true) as string;
    const intoId = textValue(op.into_id, 'into_id', true) as string;
    assertPageId(fromId);
    assertPageId(intoId);
    if (fromId === intoId) return { index, op: 'merge', id: fromId, status: 'error', detail: 'cannot merge a page into itself' };
    const from = await this.store.read(fromId);
    if (from === undefined) return { index, op: 'merge', id: fromId, status: 'error', detail: `no wiki page "${fromId}"` };
    const into = await this.store.read(intoId);
    if (into === undefined) return { index, op: 'merge', id: intoId, status: 'error', detail: `no wiki page "${intoId}"` };
    if (from.status === 'merged' && from.supersededBy === intoId) {
      return { index, op: 'merge', id: fromId, status: 'noop', detail: `already merged into ${intoId}` };
    }

    const note = op.note !== undefined ? `\n\n_Merge note: ${op.note}_` : '';
    const mergedFrom: WikiPage = {
      ...from,
      status: 'merged',
      supersededBy: intoId,
      body: `> Merged into **[[${intoId}]] (${into.title})**.${note}\n`,
      revision: from.revision + 1,
      updated: nowIso(),
    };
    const mergedInto: WikiPage = {
      ...into,
      links: unionLinks(into.links, [{ target: fromId }]),
      tags: unionList(into.tags, from.tags),
      sources: unionList(into.sources, from.sources),
      revision: into.revision + 1,
      updated: nowIso(),
    };
    await this.store.writePage(mergedFrom);
    await this.store.writePage(mergedInto);
    this.log(entries, op, [fromId, intoId], 'applied', `merged ${fromId} -> ${intoId}`);
    return { index, op: 'merge', id: fromId, status: 'applied', detail: `"${fromId}" is now a redirect stub into "${intoId}"; the duplicate title stays for history` };
  }

  private async link(op: MutationOp, index: number, entries: LogEntry[]): Promise<MutationResult> {
    const fromId = textValue(op.id, 'id (source page of the relation)', true) as string;
    const toId = textValue(op.to_id, 'to_id', true) as string;
    assertPageId(fromId);
    assertPageId(toId);
    if (fromId === toId) return { index, op: 'link', id: fromId, status: 'error', detail: 'cannot link a page to itself' };
    const from = await this.store.read(fromId);
    if (from === undefined) return { index, op: 'link', id: fromId, status: 'error', detail: `no wiki page "${fromId}"` };
    const to = await this.store.read(toId);
    if (to === undefined) return { index, op: 'link', id: toId, status: 'error', detail: `no wiki page "${toId}"` };

    const added = parseLinkEntries(op.relation !== undefined ? [`${toId} | ${op.relation}`] : [toId], fromId);
    const links = unionLinks(from.links, added);
    if (links.length === from.links.length) return { index, op: 'link', id: fromId, status: 'noop', detail: `link to "${toId}" already present` };
    await this.store.writePage({ ...from, links, revision: from.revision + 1, updated: nowIso() });
    this.log(entries, op, [fromId, toId], 'applied', `linked ${fromId} -> ${toId}`);
    return { index, op: 'link', id: fromId, status: 'applied', detail: `${fromId} -> ${toId}${op.relation !== undefined ? ` (${op.relation})` : ''}` };
  }

  private async deprecate(op: MutationOp, index: number, entries: LogEntry[]): Promise<MutationResult> {
    const id = textValue(op.id, 'id', true) as string;
    assertPageId(id);
    const page = await this.store.read(id);
    if (page === undefined) return { index, op: 'deprecate', id, status: 'error', detail: `no wiki page "${id}"` };
    if (page.status === 'deprecated' && (op.superseded_by === undefined || page.supersededBy === op.superseded_by)) {
      return { index, op: 'deprecate', id, status: 'noop', detail: 'already deprecated' };
    }
    if (op.superseded_by !== undefined) {
      assertPageId(op.superseded_by);
      const replacement = await this.store.read(op.superseded_by);
      if (replacement === undefined) return { index, op: 'deprecate', id, status: 'error', detail: `superseded_by "${op.superseded_by}" does not exist` };
    }
    const reason = op.reason ?? op.note ?? 'superseded by newer knowledge';
    const deprecated: WikiPage = {
      ...page,
      status: 'deprecated',
      supersededBy: op.superseded_by,
      body: `> **Deprecated**: ${reason}${op.superseded_by !== undefined ? ` (see [[${op.superseded_by}]])` : ''}\n\n${page.body}`,
      revision: page.revision + 1,
      updated: nowIso(),
    };
    await this.store.writePage(deprecated);
    this.log(entries, op, [id], 'applied', reason);
    return { index, op: 'deprecate', id, status: 'applied', detail: `deprecated (revision ${deprecated.revision}); page kept for history, excluded from default search` };
  }
}

/** Every page id a result touches, so the feedback covers both sides of a merge. */
function resultPages(op: MutationOp, result: MutationResult): string[] {
  const ids = [result.id];
  if (op.op === 'merge' && op.into_id !== undefined) ids.push(op.into_id);
  if (op.op === 'link' && op.to_id !== undefined) ids.push(op.to_id);
  if (op.op === 'deprecate' && op.superseded_by !== undefined) ids.push(op.superseded_by);
  return ids;
}

/**
 * One-line human summary of graph feedback, for tool results and journals.
 * Deterministic and short: the numbers first, the advice only when there is a
 * hole worth naming.
 */
export function describeGraph(feedback: GraphFeedback): string {
  const stats = feedback.stats;
  const head = `graph: ${stats.edges} edge(s) (${stats.byKind.link} link${stats.byKind.wikilink > 0 ? `, ${stats.byKind.wikilink} [[id]]` : ''}${stats.byKind.source > 0 ? `, ${stats.byKind.source} source` : ''}), ${stats.dangling} dangling, ${stats.orphans}/${stats.pages} orphan(s)`;
  const advice = feedback.notes.slice(0, 3);
  const suggestions = feedback.suggestions.reduce((sum, entry) => sum + entry.candidates.length, 0);
  const parts = [head];
  if (suggestions > 0) parts.push(`${suggestions} candidate link(s) nominated — verify them with wiki_inspect and add the ones that hold with op "link"`);
  if (advice.length > 0) parts.push(advice.join('; '));
  return parts.join(' — ');
}
