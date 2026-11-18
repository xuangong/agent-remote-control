import { canonicalContent } from './item-digest.js';
import { utf8ByteLength } from './utf8-size.js';
import type { JournalItem, JournalItemInput, ReplacementReason } from './types.js';

/**
 * The window decision: given what the Relay's journal holds and the newest item window a Controller offers on open,
 * say whether the journal already holds the window, only needs items added at its end, or must be replaced by a new
 * epoch. It is a pure function: it reads its arguments and returns data, with no clock, storage or sockets.
 *
 * Contract (seam S2, `docs/current/agent-remote/seams.md`):
 * - The window is the newest run of items. Native items (not live-only) are compared with the journal's native items
 *   by key, in order. Items older than the first key the two share are not a change, because older history is uploaded
 *   only when asked for.
 * - `unchanged`: every native item of the window is held, equal and in place, and every live-only item of the window is
 *   held and equal or updatable in place. Nothing is written.
 * - `extend`: the window only adds native items after the journal's last native item, adds live-only items with new keys,
 *   or updates a held live-only item whose type replaces its content (`tool_call`, `todo`). The epoch stays.
 * - `replace`: anything else becomes one new epoch, with the reason: `new` (the journal holds no native item),
 *   `incomplete` (the journal is missing rows), `open_item` (the first difference involves an open item) or `changed`
 *   (a complete item differs, is missing or is out of order; also an extension that does not fit the room).
 * - Live-only items take no part in the positional comparison: the Controller adds them at every open at a place the
 *   journal does not share. A live-only item the journal holds and the window lacks stays.
 * - Equality of a complete item is its digest; equality of an open item is its resident content, so an open item whose
 *   body was evicted is never equal.
 */
export function decideWindow(tail: WindowTail, window: readonly JournalItemInput[], room?: { roomBytes: number }): WindowDecision {
  if (tail.incomplete) return { outcome: 'replace', reason: 'incomplete' };
  const plan = planOf(tail, window);
  if (typeof plan === 'string') return { outcome: 'replace', reason: plan };
  if (plan.append.size === 0 && plan.update.size === 0) return { outcome: 'unchanged' };
  const bytes = window.reduce((sum, item) => sum + (plan.append.has(item.row.itemKey) || plan.update.has(item.row.itemKey) ? utf8ByteLength(JSON.stringify(item)) : 0), 0);
  if (room && tail.residentBytes() + bytes > room.roomBytes) return { outcome: 'replace', reason: 'changed' };
  return { outcome: 'extend', append: plan.append, update: plan.update, bytes };
}

/** What the journal offers the decision: its items in order, a lookup by key, whether rows are missing, and its size. */
export interface WindowTail {
  readonly items: readonly JournalItem[];
  readonly byKey: ReadonlyMap<string, JournalItem>;
  readonly incomplete: boolean;
  residentBytes(): number;
}

export type WindowDecision =
  | { outcome: 'unchanged' }
  /** `append` are keys the window adds, `update` are held live-only keys rewritten in place; `bytes` is what writing them takes. */
  | { outcome: 'extend'; append: ReadonlySet<string>; update: ReadonlySet<string>; bytes: number }
  | { outcome: 'replace'; reason: ReplacementReason };

/** The item types whose rows replace the item's content instead of adding to it. */
export const CONTENT_REPLACING_TYPES: ReadonlySet<string> = new Set(['tool_call', 'todo']);

interface WindowPlan { append: Set<string>; update: Set<string> }

function planOf(tail: WindowTail, window: readonly JournalItemInput[]): WindowPlan | ReplacementReason {
  for (const { row } of window) {
    const held = tail.byKey.get(row.itemKey);
    if (held && held.liveOnly !== (row.liveOnly === true)) return 'changed';
  }
  const extension = nativeExtension(tail, window.filter(({ row }) => row.liveOnly !== true));
  if (typeof extension === 'string') return extension;
  const plan: WindowPlan = { append: new Set(extension.map(({ row }) => row.itemKey)), update: new Set() };
  for (const item of window) {
    if (item.row.liveOnly !== true) continue;
    const held = tail.byKey.get(item.row.itemKey);
    if (!held) plan.append.add(item.row.itemKey);
    else if (held.body === null || canonicalContent(held.body.item) !== canonicalContent(item.row.item)) {
      if (held.body === null || held.body.item.type !== item.row.item.type || !CONTENT_REPLACING_TYPES.has(item.row.item.type)) return held.state === 'open' ? 'open_item' : 'changed';
      plan.update.add(item.row.itemKey);
    }
  }
  return plan;
}

function nativeExtension(tail: WindowTail, window: readonly JournalItemInput[]): JournalItemInput[] | ReplacementReason {
  const held = tail.items.filter(item => !item.liveOnly);
  if (window.length === 0) return held.length > 0 ? 'changed' : [];
  const position = new Map(held.map((item, at) => [item.itemKey, at] as const));
  const first = window.findIndex(({ row }) => position.has(row.itemKey));
  if (first < 0) return held.length > 0 ? 'changed' : 'new';
  let at = position.get((window[first] as JournalItemInput).row.itemKey) as number;
  if (first > 0 && at > 0) return 'changed';
  let next = first;
  for (; at < held.length; at += 1) {
    const current = held[at] as JournalItem;
    const wanted = window[next];
    if (!wanted || current.itemKey !== wanted.row.itemKey) return current.state === 'open' ? 'open_item' : 'changed';
    if (!sameItem(current, wanted)) return current.state === 'open' || wanted.digest === undefined ? 'open_item' : 'changed';
    next += 1;
  }
  const extension = window.slice(next);
  return extension.some(({ row }) => tail.byKey.has(row.itemKey)) ? 'changed' : extension;
}

/** Whether the journal's item is the window's item: the same key and live-only mark, and the same digest when complete or the same resident content when open. */
function sameItem(held: JournalItem, wanted: JournalItemInput): boolean {
  if (held.liveOnly !== (wanted.row.liveOnly === true)) return false;
  if (wanted.digest !== undefined) return held.digest === wanted.digest;
  return held.state === 'open' && held.body !== null && canonicalContent(held.body.item) === canonicalContent(wanted.row.item);
}
