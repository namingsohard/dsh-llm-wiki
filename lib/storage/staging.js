import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
function shortKey(input) {
    return createHash('sha1').update(JSON.stringify(input), 'utf8').digest('hex').slice(0, 8);
}
/** Deterministic entry id for a staged source proposal. */
export function stagedSourceId(url, title) {
    return `src-${shortKey(url !== undefined && url.length > 0 ? url : `title:${title}`)}`;
}
/** Deterministic entry id for a staged mutation proposal. */
export function stagedMutationId(op) {
    return `pg-${shortKey(`${op.op}:${op.id ?? op.title ?? ''}:${op.into_id ?? op.to_id ?? op.superseded_by ?? ''}`)}`;
}
/**
 * Filesystem-backed staging queue. Writes are atomic (temp + rename) and the
 * queue is ordered by staging time, oldest first.
 */
export class StagingQueue {
    dir;
    constructor(root) {
        this.dir = join(root, 'staging');
    }
    async ensure() {
        await mkdir(this.dir, { recursive: true });
    }
    path(id) {
        return join(this.dir, `${id}.json`);
    }
    /** All pending entries, oldest first; unreadable files are skipped. */
    async list() {
        let names;
        try {
            names = await readdir(this.dir);
        }
        catch {
            return { entries: [], skipped: 0 };
        }
        const entries = [];
        let skipped = 0;
        for (const name of names.sort()) {
            if (!name.endsWith('.json'))
                continue;
            try {
                const raw = JSON.parse(await readFile(join(this.dir, name), 'utf8'));
                if (typeof raw.id === 'string' && typeof raw.pitch === 'string' && raw.payload !== undefined)
                    entries.push(raw);
                else
                    skipped++;
            }
            catch {
                skipped++;
            }
        }
        entries.sort((a, b) => a.staged_at.localeCompare(b.staged_at) || a.id.localeCompare(b.id));
        return { entries, skipped };
    }
    /** Read one entry by id. */
    async read(id) {
        try {
            return JSON.parse(await readFile(this.path(id), 'utf8'));
        }
        catch {
            return undefined;
        }
    }
    /** Write (or replace) one entry atomically. */
    async put(input) {
        await this.ensure();
        const id = input.kind === 'source' && input.type === 'source'
            ? stagedSourceId(input.payload.url, input.payload.title)
            : stagedMutationId(input.payload);
        const entry = {
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
        }
        catch (error) {
            await unlink(tmp).catch(() => undefined);
            throw error;
        }
        return entry;
    }
    /** Drop entries after a decision (or an explicit discard). Missing files are fine. */
    async drop(ids) {
        await Promise.all(ids.map(async (id) => {
            await unlink(this.path(id)).catch((error) => {
                if (error.code !== 'ENOENT')
                    throw error;
            });
        }));
    }
}
//# sourceMappingURL=staging.js.map