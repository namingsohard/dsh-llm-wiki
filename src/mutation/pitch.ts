import type { MutationOp } from '../types.js';

/**
 * Human-facing one-glance summaries of proposed writes.
 *
 * These strings are what the user actually reads before deciding, in three
 * places: the `staged` result of a gated write, the `wiki_review` listing, and
 * the harness approval prompt. That last one is the reason this module exists:
 * an approval request carries only a tool name and a reason string, never the
 * tool arguments, so the pitch has to stand on its own.
 *
 * @module dsh-llm-wiki/mutation/pitch
 */

const PITCH_BODY_CHARS = 220;
const PITCH_LIST_ITEMS = 6;

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function clampInline(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The first prose line of a body, skipping quote and heading markers. */
export function firstProseLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.replace(/^[-*>#\s]+/, '').trim();
    if (line.length > 0) return line;
  }
  return '';
}

function list(items: readonly string[]): string {
  const shown = items.slice(0, PITCH_LIST_ITEMS).join(', ');
  return items.length > PITCH_LIST_ITEMS ? `${shown} +${(items.length - PITCH_LIST_ITEMS).toString()} more` : shown;
}

/** Render one mutation operation as `OP id — what changes (why it is worth keeping)`. */
export function renderOpPitch(op: MutationOp, detail?: string): string {
  const id = op.id ?? op.title ?? '(derived id)';
  switch (op.op) {
    case 'create': {
      const head = firstProseLine(op.body ?? '');
      const extras = [`tags: ${list(op.tags ?? [])}`, `links: ${list(op.links ?? [])}`, `sources: ${list(op.sources ?? [])}`].filter((part) => !part.endsWith(': '));
      return `CREATE ${id} "《${op.title ?? ''}》" — ${head.length > 0 ? clampInline(head, PITCH_BODY_CHARS) : '(empty body)'} · ${extras.join(' · ')}`;
    }
    case 'update': {
      const what: string[] = [];
      if (op.body !== undefined) what.push(`body → ${clampInline(op.body, PITCH_BODY_CHARS)}`);
      if (op.title !== undefined) what.push(`title → ${op.title}`);
      if (op.status !== undefined) what.push(`status → ${op.status}`);
      if (op.tags !== undefined) what.push(`tags += ${list(op.tags)}`);
      if (op.links !== undefined) what.push(`links += ${list(op.links)}`);
      if (op.sources !== undefined) what.push(`sources += ${list(op.sources)}`);
      return `UPDATE ${id} — ${what.length > 0 ? what.join(' · ') : 'metadata only'}`;
    }
    case 'merge':
      return `MERGE ${id} → ${op.into_id ?? '(missing into_id)'} — the weaker id becomes a redirect stub; its tags and sources move to the survivor`;
    case 'link':
      return `LINK ${id} → ${op.to_id ?? '(missing to_id)'}${op.relation !== undefined ? ` (${op.relation})` : ''}`;
    case 'deprecate':
      return `DEPRECATE ${id} — ${op.reason ?? op.note ?? 'no longer holds'}${op.superseded_by !== undefined ? ` · superseded by ${op.superseded_by}` : ''}`;
    default:
      return `${String(op.op)} ${id}`;
  }
}

/** Render a staged source card as a single review line. */
export function renderSourcePitch(title: string, url: string | undefined): string {
  return `SOURCE card "${clampInline(title, 100)}"${url !== undefined ? ` — ${url}` : ''} · link only, no text stored`;
}

/** One entry of the approval headline. */
export interface ApprovalLine {
  /** Upper-cased operation word, e.g. `SOURCE`, `CREATE`, `DEPRECATE`. */
  op: string;
  /** Human-readable subject: page title, or `id → target` for rewrites. */
  label: string;
  /** The extractor's stated reason, flattened and clamped. */
  reason: string;
}

/** At most this many proposals get named before the line switches to a count. */
const APPROVAL_ITEMS = 4;
const APPROVAL_LABEL_CHARS = 70;
const APPROVAL_REASON_CHARS = 90;
/** Card budget for the item run; the framing sentences are always kept. */
const APPROVAL_TOTAL_CHARS = 560;
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

/**
 * Render the approval prompt as one deliberate single line.
 *
 * The harness approval card puts `reason` in a plain div with the default
 * `white-space`, so newlines collapse to spaces and markdown never renders —
 * a multi-line pitch arrives as one unreadable wall of prose. Circled numbers
 * and `‖` separators keep the items apart however the card wraps, and the
 * detail that does not fit stays where newlines do work: in the tool result
 * (`wiki_review` rows) and in whatever the model put in its reply first.
 */
export function renderApprovalPitch(items: readonly ApprovalLine[]): string {
  const shown = items.slice(0, APPROVAL_ITEMS);
  const parts = shown.map((item, index) => {
    const marker = CIRCLED[index] ?? `(${(index + 1).toString()})`;
    const why = clampInline(item.reason, APPROVAL_REASON_CHARS);
    return `${marker} ${item.op} ${clampInline(item.label, APPROVAL_LABEL_CHARS)}${why.length > 0 ? ` (why: ${why})` : ''}`;
  });
  if (items.length > shown.length) parts.push(`+${(items.length - shown.length).toString()} more, listed in the wiki_review result`);

  const head = `${items.length.toString()} wiki proposal(s) awaiting approval: `;
  const tail = '. Allow once writes all of them into the live wiki; reject or cancel drops every one for good.';
  const body = clampInline(parts.join('  ‖  '), Math.max(60, APPROVAL_TOTAL_CHARS - head.length - tail.length));
  return `${head}${body}${tail}`;
}
