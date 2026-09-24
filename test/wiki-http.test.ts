import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWikiHttpHandlers, registerWikiHttp } from '../src/browser/wiki-http.js';
import { resolveConfig } from '../src/config.js';
import { WikiStore } from '../src/storage/markdown-store.js';
import { StagingQueue } from '../src/storage/staging.js';
import type { WikiPage } from '../src/types.js';
import type { WikiHttpRequest, WikiHttpResponse } from '../src/browser/wiki-http.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-wiki-http-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Collect one handler call against a fake response. */
async function call(
  handler: (req: WikiHttpRequest, res: WikiHttpResponse) => Promise<void>,
  url: string,
  method = 'GET',
): Promise<{ status: number; body: any }> {
  const chunks: string[] = [];
  const res: WikiHttpResponse = {
    statusCode: 0,
    writableEnded: false,
    setHeader() {},
    end(chunk?: string) {
      if (chunk !== undefined) chunks.push(chunk);
      this.writableEnded = true;
    },
  };
  await handler({ method, url }, res);
  const text = chunks.join('');
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  return { status: res.statusCode, body };
}

function page(overrides: Partial<WikiPage>): WikiPage {
  const now = new Date('2026-03-01T08:00:00.000Z').toISOString();
  return {
    id: 'alpha',
    kind: 'concept',
    title: 'Alpha',
    status: 'active',
    revision: 1,
    created: now,
    updated: now,
    tags: ['t'],
    links: [],
    sources: [],
    body: 'Body text.\n',
    path: '',
    ...overrides,
  };
}

async function seed(store: WikiStore): Promise<void> {
  await store.ensureInit();
  await store.writePage(page({}));
  await store.writePage(page({ id: 'mars', kind: 'entity', title: '火星：基本参数', status: 'deprecated', supersededBy: 'alpha' }));
  await store.writePage(page({ id: 'src-20260301-aaaa1111', kind: 'source', title: 'Example Source', url: 'https://example.com/a', obtained: '2026-03-01T09:00:00.000Z' }));
}

describe('wiki-http /wiki/tree', () => {
  it('lists sections by kind with titles and the staging queue', async () => {
    const store = new WikiStore(root);
    const staging = new StagingQueue(root);
    await seed(store);
    await staging.ensure();
    await staging.put({ kind: 'concept', type: 'mutation', payload: { op: 'create', id: 'beta' }, pitch: `A\n  multi   line pitch that is quite long and should collapse into one readable line for the tree listing view without breaking`.trim() });

    const handlers = createWikiHttpHandlers(store, staging, resolveConfig());
    const { status, body } = await call(handlers.tree, '/wiki/tree');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.root).toBe(root);
    expect(body.approval).toBe('staging');
    const concepts = body.sections.find((s: any) => s.kind === 'concept');
    expect(concepts.pages.map((p: any) => p.id)).toEqual(['alpha']);
    const entities = body.sections.find((s: any) => s.kind === 'entity');
    expect(entities.pages[0]).toMatchObject({ id: 'mars', title: '火星：基本参数', status: 'deprecated' });
    const sources = body.sections.find((s: any) => s.kind === 'source');
    expect(sources.pages.map((p: any) => p.id)).toEqual(['src-20260301-aaaa1111']);
    expect(body.staging).toHaveLength(1);
    expect(body.staging[0].pitch).not.toContain('\n');
    expect(body.staging[0].pitch.length).toBeLessThanOrEqual(160);
    expect(body.failures).toEqual([]);
  });

  it('answers an empty tree for a root that was never initialized', async () => {
    const store = new WikiStore(join(root, 'missing'));
    const handlers = createWikiHttpHandlers(store, new StagingQueue(join(root, 'missing')), resolveConfig());
    const { status, body } = await call(handlers.tree, '/wiki/tree');
    expect(status).toBe(200);
    expect(body.sections.map((s: any) => s.pages.length)).toEqual([0, 0, 0]);
    expect(body.staging).toEqual([]);
  });

  it('rejects non-GET methods', async () => {
    const store = new WikiStore(root);
    const handlers = createWikiHttpHandlers(store, new StagingQueue(root), resolveConfig());
    const { status } = await call(handlers.tree, '/wiki/tree', 'POST');
    expect(status).toBe(405);
  });
});

describe('wiki-http /wiki/page', () => {
  it('returns parsed frontmatter plus the Markdown body', async () => {
    const store = new WikiStore(root);
    await seed(store);
    const handlers = createWikiHttpHandlers(store, new StagingQueue(root), resolveConfig());

    const { status, body } = await call(handlers.page, '/wiki/page?kind=entity&id=mars');
    expect(status).toBe(200);
    expect(body.page).toMatchObject({
      id: 'mars',
      kind: 'entity',
      title: '火星：基本参数',
      status: 'deprecated',
      supersededBy: 'alpha',
      truncated: false,
    });
    expect(body.page.body).toContain('Body text');
    expect(body.page.url).toBeUndefined();
  });

  it('carries source url and obtained', async () => {
    const store = new WikiStore(root);
    await seed(store);
    const handlers = createWikiHttpHandlers(store, new StagingQueue(root), resolveConfig());
    const { body } = await call(handlers.page, '/wiki/page?kind=source&id=src-20260301-aaaa1111');
    expect(body.page.url).toBe('https://example.com/a');
    expect(body.page.obtained).toBe('2026-03-01T09:00:00.000Z');
  });

  it('truncates a body past the inspect cap', async () => {
    const store = new WikiStore(root);
    await store.ensureInit();
    await store.writePage(page({ body: 'x'.repeat(40 * 1024) }));
    const handlers = createWikiHttpHandlers(store, new StagingQueue(root), resolveConfig({ maxInspectBytes: 2048 }));
    const { body } = await call(handlers.page, '/wiki/page?kind=concept&id=alpha');
    expect(body.page.truncated).toBe(true);
    expect(body.page.body.length).toBeLessThan(3000);
  });

  it('refuses traversal and unknown kinds before touching the disk', async () => {
    const store = new WikiStore(root);
    await seed(store);
    const handlers = createWikiHttpHandlers(store, new StagingQueue(root), resolveConfig());

    expect((await call(handlers.page, '/wiki/page?kind=concept&id=..%2F..%2Fsecrets')).status).toBe(400);
    expect((await call(handlers.page, '/wiki/page?kind=logs&id=alpha')).status).toBe(400);
    expect((await call(handlers.page, '/wiki/page?id=alpha')).status).toBe(400);
    // Valid shape, wrong directory: ids are global, the kind must agree.
    expect((await call(handlers.page, '/wiki/page?kind=source&id=alpha')).status).toBe(404);
    expect((await call(handlers.page, '/wiki/page?kind=concept&id=gone')).status).toBe(404);
  });
});

describe('wiki-http /wiki/staged', () => {
  it('reads back a staged proposal whole', async () => {
    const staging = new StagingQueue(root);
    await staging.ensure();
    const put = await staging.put({ kind: 'concept', type: 'mutation', payload: { op: 'update', id: 'alpha', body: 'new' }, pitch: 'Update alpha', reason: 'drift' });

    const handlers = createWikiHttpHandlers(new WikiStore(root), staging, resolveConfig());
    const { status, body } = await call(handlers.staged, `/wiki/staged?id=${put.id}`);
    expect(status).toBe(200);
    expect(body.staged).toMatchObject({ id: put.id, kind: 'concept', type: 'mutation', pitch: 'Update alpha', reason: 'drift' });
    expect(body.staged.payload.id).toBe('alpha');
  });

  it('404s an unknown id and 400s a malformed one', async () => {
    const handlers = createWikiHttpHandlers(new WikiStore(root), new StagingQueue(root), resolveConfig());
    expect((await call(handlers.staged, '/wiki/staged?id=pg-00000000')).status).toBe(404);
    expect((await call(handlers.staged, '/wiki/staged?id=%2E%2E%2Fleak')).status).toBe(400);
    expect((await call(handlers.staged, '/wiki/staged')).status).toBe(400);
  });
});

interface FakeRoute {
  kind: string;
  path: string;
  handler: (req: WikiHttpRequest, res: WikiHttpResponse) => Promise<void>;
}

/** A context whose services appear on demand, mirroring a racing composition. */
function fakeHost() {
  const services = new Map<string, unknown>();
  const routes: FakeRoute[] = [];
  let effectDispose: (() => void) | undefined;
  const ctx: any = {
    logger: { info() {}, warn() {}, debug() {} },
    get(name: string) {
      return services.get(name);
    },
    effect(fn: () => (() => void) | void) {
      effectDispose = fn() as (() => void) | undefined;
    },
  };
  const webServer = {
    register(route: FakeRoute) {
      routes.push(route);
      return () => {
        const at = routes.indexOf(route);
        if (at >= 0) routes.splice(at, 1);
      };
    },
  };
  return {
    ctx,
    routes,
    webServer,
    serve(name: string, value: unknown) {
      services.set(name, value);
    },
    dispose: () => effectDispose?.(),
  };
}

/** The one registered route for a path; its absence fails the test loudly. */
function routeOf(host: ReturnType<typeof fakeHost>, path: string): FakeRoute {
  const route = host.routes.find((r) => r.path === path);
  if (route === undefined) throw new Error(`route ${path} not registered`);
  return route;
}

describe('wiki-http registration race', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers when webServer appears late and serves once the fence arrives', async () => {
    vi.useFakeTimers();
    const store = new WikiStore(root);
    const host = fakeHost();
    registerWikiHttp(host.ctx, store, new StagingQueue(root), resolveConfig());
    expect(host.routes).toHaveLength(0);

    host.serve('webServer', host.webServer);
    await vi.advanceTimersByTimeAsync(600);
    expect(host.routes.map((r) => r.path).sort()).toEqual(['/wiki/page', '/wiki/staged', '/wiki/tree']);

    // Fence not yet provided: every route fails closed with 503.
    const tree = routeOf(host, '/wiki/tree');
    expect((await call(tree.handler, '/wiki/tree')).status).toBe(503);

    let reject: number | undefined;
    host.serve('connection', { requestRejection: () => reject });
    expect((await call(tree.handler, '/wiki/tree')).status).toBe(200);
    reject = 403;
    expect((await call(tree.handler, '/wiki/tree')).status).toBe(403);
  });

  it('lapses quietly without a web surface and never registers after the window', async () => {
    vi.useFakeTimers();
    const host = fakeHost();
    registerWikiHttp(host.ctx, new WikiStore(root), new StagingQueue(root), resolveConfig());
    await vi.advanceTimersByTimeAsync(46_000);
    expect(host.routes).toHaveLength(0);
    host.serve('webServer', host.webServer);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.routes).toHaveLength(0);
  });

  it('stops retrying and unregisters routes on dispose', async () => {
    vi.useFakeTimers();
    const host = fakeHost();
    registerWikiHttp(host.ctx, new WikiStore(root), new StagingQueue(root), resolveConfig());

    // Disposed before the web surface: the retry must not resurrect it.
    host.dispose();
    host.serve('webServer', host.webServer);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.routes).toHaveLength(0);

    // Registered case: dispose removes what was registered.
    const live = fakeHost();
    live.serve('webServer', live.webServer);
    registerWikiHttp(live.ctx, new WikiStore(root), new StagingQueue(root), resolveConfig());
    expect(live.routes).toHaveLength(3);
    live.dispose();
    expect(live.routes).toHaveLength(0);
  });
});
