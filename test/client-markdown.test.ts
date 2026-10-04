import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The sidebar reader's Markdown renderer.
 *
 * `client/wiki-client.js` ships as one lazy-CJS factory that only exports
 * `apply`/`inject`, so the renderer has no import surface: this suite slices
 * the renderer section out of the bundle text and evaluates it against a fake
 * `createElement`. The section is delimited by its own markers, so a rename
 * fails loudly here rather than skipping the cases below.
 *
 * The case that matters is the one that took down DSH Desktop: `inlineNodes`
 * recurses (bold, italics, strike and link content is rendered through itself),
 * and a single module-level `g` regex carries `lastIndex` across those frames.
 * The nested call reset the cursor the parent was walking, the parent matched
 * its first token again from 0, and any page with `**bold**` or a `[link](url)`
 * built nodes until the renderer died. Hence the node budget: an infinite loop
 * must fail the test, not the test worker's heap.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const bundle = readFileSync(join(root, 'client', 'wiki-client.js'), 'utf8');

/** A rendered leaf: the fake element keeps just enough shape to assert on. */
interface Element {
  type: string;
  props: Record<string, unknown> | null;
  children: Rendered[];
}

type Rendered = Element | string;

/** Read the renderer section out of the bundle (grammar through `renderMarkdown`). */
function loadRenderer(nodeBudget: number): (md: string) => Rendered[] {
  const start = bundle.indexOf('const INLINE_PATTERN');
  const end = bundle.indexOf('/* -------------------------------------------------------------- views */');
  if (start < 0 || end < 0 || end < start) throw new Error('renderer section not found in client/wiki-client.js');
  let calls = 0;
  const h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Element => {
    calls += 1;
    if (calls > nodeBudget) throw new Error('NODE_BUDGET_EXCEEDED');
    return { type, props, children: children.flat() as Rendered[] };
  };
  const factory = new Function('h', `${bundle.slice(start, end)}\nreturn renderMarkdown;`) as (
    create: typeof h,
  ) => (md: string) => Rendered[];
  return factory(h);
}

/** Every text node of a rendered tree, concatenated. */
function textOf(nodes: Rendered[]): string {
  return nodes.map((node) => (typeof node === 'string' ? node : textOf(node.children))).join('');
}

/** First element of the given tag, depth first. */
function find(nodes: Rendered[], type: string): Element | undefined {
  for (const node of nodes) {
    if (typeof node === 'string') continue;
    if (node.type === type) return node;
    const inner = find(node.children, type);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

const render = loadRenderer(20_000);

describe('wiki browser markdown renderer', () => {
  it('renders a bold bullet and terminates (the reader-pane hang regression)', () => {
    const out = render('- **BaseFOV 调高（如 120）→ 切换距离被拉长**（远景角色更清晰）');
    const strong = find(out, 'strong');
    expect(strong).toBeDefined();
    expect(textOf(strong!.children)).toBe('BaseFOV 调高（如 120）→ 切换距离被拉长');
    expect(textOf(out)).toContain('（远景角色更清晰）');
  });

  it('renders an inline link and keeps its label text after the match', () => {
    const out = render('> [Mars Fact Sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html) · obtained 2026-09-23');
    const anchor = find(out, 'a');
    expect(anchor).toBeDefined();
    expect(anchor!.props?.href).toBe('https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html');
    expect(textOf(out)).toContain('· obtained 2026-09-23');
  });

  it('keeps a non-http target as a dead link, not an anchor', () => {
    const out = render('see [the workspace page](wwmi-mod-workspace) for details');
    expect(find(out, 'a')).toBeUndefined();
    expect(find(out, 'span')!.props?.className).toBe('dshwiki-deadlink');
    expect(textOf(out)).toContain('for details');
  });

  it('renders nested inline markup without losing the tail', () => {
    const out = render('**bold with `code` inside** and ~~struck `more`~~ then *em `tail`* done');
    expect(textOf(out)).toContain('then');
    expect(textOf(out)).toContain('done');
    expect(find(out, 'strong')).toBeDefined();
    expect(find(out, 'del')).toBeDefined();
    expect(find(out, 'em')).toBeDefined();
  });

  it('walks a paragraph with several tokens in one line exactly once', () => {
    const out = render('plain **one** mid `two` mid **three** end');
    expect(textOf(out)).toBe('plain one mid two mid three end');
  });

  it('survives the whole reader surface: headings, fences, quotes, lists', () => {
    const out = render(
      ['# Title **bold**', '', 'Intro `c` and [x](https://e.com) tail.', '', '```', 'code **not** parsed', '```', '', '> quote [y](https://f.com)', '', '- a **b**', '- c'].join('\n'),
    );
    expect(find(out, 'h2')).toBeDefined();
    expect(find(out, 'pre')).toBeDefined();
    expect(textOf(out)).toContain('code **not** parsed');
  });
});
