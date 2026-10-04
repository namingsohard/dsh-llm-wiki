import type { LogEntry, MutationOp, MutationResult, PageKind, WikiLink, WikiPage } from '../types.js';
import type { WikiConfig } from '../config.js';
import { assertPageId, isValidPageId, slugifyTitle } from '../storage/id-slug.js';
import type { WikiStore } from '../storage/markdown-store.js';
import { assertAdmissionScores, evaluateAdmission } from './admission.js';

/**
 * Mutation Engine: applies incremental knowledge mutations to the wiki —
 * CREATE / UPDATE / MERGE / LINK / DEPRECATE — instead of rewriting pages.
 * CREATE passes through the Admission Controller; every outcome (applied,
 * rejected, error) is journaled so the update history stays auditable.
 *
 * Concurrency: mutations route through the store's in-process lock; page
 * revisions make lost updates detectable by the linter, not silently merged.
 *
 * @module dsh-llm-wiki/mutation/mutator
 */

export interface MutateOutcome {
  results: MutationResult[];
  applied: number;
  rejected: number;
  indexRebuilt: boolean;
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
      const results: MutationResult[] = [];
      const entries: LogEntry[] = [];
      let applied = 0;
      let rejected = 0;

      for (const [index, raw] of ops.entries()) {
        const op = raw as MutationOp;
        let result: MutationResult;
        try {
          result = await this.applyOne(op, index, entries);
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
        if (result.status === 'applied') applied++;
        if (result.status === 'rejected' || result.status === 'error') rejected++;
      }

      let indexRebuilt = false;
      if (applied > 0) {
        await this.store.rebuildIndex();
        indexRebuilt = true;
      }
      if (this.config.mutationLog && entries.length > 0) await this.store.appendLog(entries);
      return { results, applied, rejected, indexRebuilt };
    });
  }

  private log(entries: LogEntry[], op: MutationOp, pages: string[], result: string, detail?: string): void {
    const entry: LogEntry = { ts: nowIso(), op: op.op, pages, result };
    if (op.note !== undefined) entry.note = op.note;
    if (detail !== undefined) entry.note = entry.note === undefined ? detail : `${entry.note} — ${detail}`;
    entries.push(entry);
  }

  private async applyOne(op: MutationOp, index: number, entries: LogEntry[]): Promise<MutationResult> {
    switch (op.op) {
      case 'create':
        return await this.create(op, index, entries);
      case 'update':
        return await this.update(op, index, entries);
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

  private async create(op: MutationOp, index: number, entries: LogEntry[]): Promise<MutationResult> {
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

    const now = nowIso();
    const links = parseLinkEntries(op.links ?? [], id);
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

  private async update(op: MutationOp, index: number, entries: LogEntry[]): Promise<MutationResult> {
    const id = textValue(op.id, 'id', true) as string;
    assertPageId(id);
    const page = await this.store.read(id);
    if (page === undefined) return { index, op: 'update', id, status: 'error', detail: `no wiki page "${id}"` };

    const body = op.body !== undefined ? textValue(op.body, 'body', false) : undefined;
    if (op.body !== undefined && body === undefined) throw new Error('body must be a string');
    if (body !== undefined) this.checkBodySize(id, body);
    const title = op.title !== undefined ? (textValue(op.title, 'title', false) as string) : undefined;

    const updated: WikiPage = {
      ...page,
      title: title ?? page.title,
      body: body !== undefined ? body.trimEnd() + '\n' : page.body,
      status: op.status ?? page.status,
      tags: op.tags !== undefined ? unionList(page.tags, op.tags) : page.tags,
      links: op.links !== undefined ? unionLinks(page.links, parseLinkEntries(op.links, id)) : page.links,
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
