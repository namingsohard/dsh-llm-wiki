import { freshnessOf } from '../retrieval/freshness.js';
function normalizeTitle(title) {
    return title
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 0)
        .sort()
        .join(' ');
}
function tokenSet(page) {
    return new Set([...page.title.toLowerCase().split(/[^\p{L}\p{N}]+/u), ...page.tags.map((tag) => tag.toLowerCase())].filter((t) => t.length > 0));
}
function jaccard(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let shared = 0;
    for (const token of a)
        if (b.has(token))
            shared++;
    return shared / (a.size + b.size - shared);
}
/** Run all lint checks over the wiki. */
export async function lintWiki(store, config) {
    const { pages, failures } = await store.listPages(['concept', 'entity', 'source']);
    const issues = [];
    const ids = new Map(pages.map((page) => [page.id, page]));
    // Broken links: every link target must resolve to an existing page.
    for (const page of pages) {
        for (const link of page.links) {
            if (!ids.has(link.target)) {
                issues.push({ check: 'broken-link', level: 'warn', page: page.id, message: `link target "${link.target}" does not exist${link.relation !== undefined ? ` (relation: ${link.relation})` : ''}` });
            }
        }
    }
    // Deprecated references: active pages pointing at archived knowledge.
    for (const page of pages) {
        if (page.status !== 'active')
            continue;
        for (const link of page.links) {
            const target = ids.get(link.target);
            if (target !== undefined && target.status !== 'active') {
                issues.push({ check: 'deprecated-ref', level: 'info', page: page.id, message: `links to ${target.status} page "${target.id}"${target.supersededBy !== undefined ? ` (superseded by ${target.supersededBy})` : ''}` });
            }
        }
    }
    // Duplicates among active wiki-layer pages.
    const active = pages.filter((page) => page.kind !== 'source' && page.status === 'active');
    for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
            const a = active[i];
            const b = active[j];
            if (a.kind !== b.kind)
                continue;
            if (normalizeTitle(a.title) === normalizeTitle(b.title)) {
                issues.push({ check: 'duplicate', level: 'warn', page: a.id, message: `same normalized title as "${b.id}" ("${b.title}") — consider wiki_mutate merge` });
                continue;
            }
            const similarity = jaccard(tokenSet(a), tokenSet(b));
            if (similarity >= 0.6) {
                issues.push({ check: 'duplicate', level: 'info', page: a.id, message: `highly similar to "${b.id}" (title/tag overlap ${(similarity * 100).toFixed(0)}%) — review for merge` });
            }
        }
    }
    // Stale active pages.
    for (const page of active) {
        const freshness = freshnessOf(page, config.agingAfterDays, config.staleAfterDays);
        if (freshness === 'stale') {
            issues.push({ check: 'stale', level: 'info', page: page.id, message: `not updated for ${config.staleAfterDays}+ days (last: ${page.updated.slice(0, 10)}) — verify against current sources or deprecate` });
        }
    }
    // Orphans: active wiki-layer pages with no inbound links.
    if (config.lintOrphans) {
        const inbound = new Map();
        for (const page of pages) {
            for (const link of page.links) {
                const list = inbound.get(link.target) ?? [];
                list.push(page.id);
                inbound.set(link.target, list);
            }
        }
        for (const page of active) {
            const incoming = inbound.get(page.id) ?? [];
            if (incoming.length === 0) {
                issues.push({ check: 'orphan', level: 'info', page: page.id, message: 'no inbound links from any page — link it from a related page or it will fade from reuse' });
            }
        }
    }
    // Oversize pages.
    for (const page of active) {
        const bytes = Buffer.byteLength(page.body, 'utf8');
        if (bytes > config.maxPageBytes * 0.8) {
            issues.push({ check: 'oversize', level: 'info', page: page.id, message: `body is ${bytes} bytes (${((bytes / config.maxPageBytes) * 100).toFixed(0)}% of cap) — consider splitting into linked pages` });
        }
    }
    issues.sort((a, b) => (a.level === b.level ? a.check.localeCompare(b.check) || a.page.localeCompare(b.page) : a.level === 'warn' ? -1 : 1));
    const warn = issues.filter((issue) => issue.level === 'warn').length;
    return { issues, counts: { warn, info: issues.length - warn }, scanned: pages.length, parseFailures: failures };
}
//# sourceMappingURL=wiki-linter.js.map