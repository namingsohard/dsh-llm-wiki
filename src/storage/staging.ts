import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { MutationOp, PageKind } from '../types.js';

/**
 * The write gate's holding area: `<wiki root>/staging/`.
 *
 * Every proposed write lands here as one JSON envelope before it can reach the
 * live layers, so an unapproved proposal never shows up in `wiki_search`,
 * `wiki_lint`, or `index.md`. The linter reads only the three kind
 * directories, which is what makes staging inert by construction.
 *
 * Entry ids are stable across sessions (`<kind>-<hash8>`), so re-proposing the
 * same source or the same mutation replaces its entry instead of piling up
 * duplicates.
 *
 * @module dsh-llm-wiki/storage/staging
 */

/** What kind of write a staged entry holds. */
export type StageKind = 'source' | PageKind;

/** One proposed write waiting for the user's decision. */
export interface StagedEntry {
  /** Stable pending id, e.g. `src-1a2b3c4d` or `pg-9f8e7d6c`; what `wiki_review` keys on. */
  id: string;
  kind: StageKind;
  /** What this entry becomes: a source page or a mutation operation. */
  type: 'source' | 'mutation';
  /** The proposed write: `{ title, url, obtained, content }` or a {@link MutationOp}. */
  payload: unknown;
  /** One-paragraph pitch shown to the user. */
  pitch: string;
  /** Why the model thinks this belongs in the wiki (its own words). */
  reason?: string;
  /** Admission verdict computed at stage time; the controller still decides at promote time. */
  admission?: { average: number; minimum: number; accept: boolean };
  /** The model's own admission scores, when it supplied any. */
  scores?: Record<string, number>;
  /** ISO-8601 staging timestamp. */
  staged_at: string;
}

export interface StageInput {
  kind: StageKind;
  type: StagedEntry['type'];
  payload: unknown;
  pitch: string;
  reason?: string;
  admission?: StagedEntry['admission'];
  scores?: Record<string, number>;
  stagedAt?: string;
}

function shortKey(input: unknown): string {
  return createHash('sha1').update(JSON.stringify(input), 'utf8').digest('hex').slice(0, 8);
}

/** Deterministic entry id for a staged source proposal. */
export function stagedSourceId(url: string | undefined, title: string): string {
  return `src-${shortKey(url !== undefined && url.length > 0 ? url : `title:${title}`)}`;
}

/** Deterministic entry id for a staged mutation proposal. */
export function stagedMutationId(op: MutationOp): string {
  return `pg-${shortKey(`${op.op}:${op.id ?? op.title ?? ''}:${op.into_id ?? op.to_id ?? op.superseded_by ?? ''}`)}`;
}

/**
 * Filesystem-backed staging queue. Writes are atomic (temp + rename) and the
 * queue is ordered by staging time, oldest first.
 */
export class StagingQueue {
  readonly dir: string;

  constructor(root: string) {
    this.dir = join(root, 'staging');
  }

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** All pending entries, oldest first; unreadable files are skipped. */
  async list(): Promise<{ entries: StagedEntry[]; skipped: number }> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return { entries: [], skipped: 0 };
    }
    const entries: StagedEntry[] = [];
    let skipped = 0;
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as StagedEntry;
        if (typeof raw.id === 'string' && typeof raw.pitch === 'string' && raw.payload !== undefined) entries.push(raw);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    entries.sort((a, b) => a.staged_at.localeCompare(b.staged_at) || a.id.localeCompare(b.id));
    return { entries, skipped };
  }

  /** Read one entry by id. */
  async read(id: string): Promise<StagedEntry | undefined> {
    try {
      return JSON.parse(await readFile(this.path(id), 'utf8')) as StagedEntry;
    } catch {
      return undefined;
    }
  }

  /** Write (or replace) one entry atomically. */
  async put(input: StageInput): Promise<StagedEntry> {
    await this.ensure();
    const id = input.kind === 'source' && input.type === 'source'
      ? stagedSourceId((input.payload as { url?: string }).url, (input.payload as { title: string }).title)
      : stagedMutationId(input.payload as MutationOp);
    const entry: StagedEntry = {
      id,
      kind: input.kind,
      type: input.type,
      payload: input.payload,
      pitch: input.pitch,
      staged_at: input.stagedAt ?? new Date().toISOString(),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.admission !== undefined ? { admission: input.admission } : {}),
      ...(input.scores !== undefined ? { scores: input.scores } : {}),
    };
    const path = this.path(id);
    const tmp = `${path}.tmp-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    try {
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
    return entry;
  }

  /** Drop entries after a decision (or an explicit discard). Missing files are fine. */
  async drop(ids: readonly string[]): Promise<void> {
    await Promise.all(ids.map(async (id) => {
      await unlink(this.path(id)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }));
  }
}
