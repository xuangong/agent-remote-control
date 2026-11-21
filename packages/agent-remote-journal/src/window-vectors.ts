import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';

import type { WindowDecision, WindowOrder, WindowTail } from './window-decision.js';
import type { JournalItem, JournalItemInput, ReplacementReason } from './types.js';

/**
 * The vector table of the window decision (`decideWindow`): what the Relay's journal holds, the window a Controller
 * offers on open, and the decision. One table, read by every layer that owns a piece of the rule: the journal runs
 * the decision, the Controller's publisher builds the window from timeline items, and the client replica absorbs the
 * window by item key. Items are written in a compact form; `heldTail` and `windowItems` build the real shapes.
 */
export interface VectorItem {
  key: string;
  /** The item's text. Two items of one key are equal when their text is. Defaults to the key. */
  text?: string;
  /** `complete` (the default) carries a digest; `open` is still being written and is compared by content. */
  state?: 'complete' | 'open';
  /** Native history cannot rebuild it. */
  live?: true;
  /** The kind of content. `message` is the default; `tool` and `board` replace their content when a row arrives. */
  kind?: 'message' | 'tool' | 'board';
  /** A held item whose body was evicted from memory. */
  evicted?: true;
  /** The turn the item belongs to; `turn-1` by default. */
  turn?: string;
}

export type VectorExpectation =
  | { outcome: 'unchanged' }
  | { outcome: 'extend'; append: string[]; update?: string[] }
  | { outcome: 'replace'; reason: ReplacementReason };

export interface WindowVector {
  name: string;
  held: VectorItem[];
  window: VectorItem[];
  /** The journal is missing rows. */
  incomplete?: true;
  /** The journal's size and the room it may fill, in bytes, for a vector about an extension that does not fit. */
  room?: { resident: number; roomBytes: number };
  /** How the window lists the siblings of a turn; the live order by default. */
  order?: WindowOrder;
  expect: VectorExpectation;
}

const done = (key: string, text?: string): VectorItem => ({ key, ...(text === undefined ? {} : { text }) });
const open = (key: string, text?: string): VectorItem => ({ ...done(key, text), state: 'open' });
const live = (key: string, text?: string): VectorItem => ({ ...done(key, text), live: true });
const liveOpen = (key: string, text?: string): VectorItem => ({ ...open(key, text), live: true });
const tool = (key: string, text: string): VectorItem => ({ ...live(key, text), kind: 'tool' });
const board = (key: string, text: string): VectorItem => ({ ...live(key, text), kind: 'board' });
const evicted = (item: VectorItem): VectorItem => ({ ...item, evicted: true });
const inTurn = (turn: string, ...keys: string[]): VectorItem[] => keys.map(key => ({ key, turn }));
const unchanged: VectorExpectation = { outcome: 'unchanged' };
const extend = (append: string[], update: string[] = []): VectorExpectation => ({ outcome: 'extend', append, ...(update.length === 0 ? {} : { update }) });
const replace = (reason: ReplacementReason): VectorExpectation => ({ outcome: 'replace', reason });

export const windowVectors: readonly WindowVector[] = [
  // The journal already holds the window.
  { name: 'an empty window over an empty journal changes nothing', held: [], window: [], expect: unchanged },
  { name: 'the same items in the same order change nothing', held: [done('a'), done('b')], window: [done('a'), done('b')], expect: unchanged },
  { name: 'a window that is the end of the journal changes nothing', held: [done('a'), done('b'), done('c')], window: [done('b'), done('c')], expect: unchanged },
  { name: 'a window of the last item alone changes nothing', held: [done('a'), done('b'), done('c')], window: [done('c')], expect: unchanged },
  { name: 'a window that reaches further back than the journal changes nothing, since older history comes on request', held: [done('b'), done('c')], window: [done('a'), done('b'), done('c')], expect: unchanged },
  { name: 'an open item with the same content changes nothing', held: [done('a'), open('b', 'so far')], window: [done('a'), open('b', 'so far')], expect: unchanged },
  { name: 'an empty window over a journal of live-only items alone changes nothing', held: [live('x')], window: [], expect: unchanged },
  { name: 'a live-only item the window lacks stays and changes nothing', held: [done('a'), live('x')], window: [done('a')], expect: unchanged },
  { name: 'an equal live-only item changes nothing', held: [done('a'), live('x')], window: [done('a'), live('x')], expect: unchanged },
  { name: 'a live-only item the Controller re-adds at the end of its window changes nothing, wherever the journal holds it', held: [live('x'), done('a'), done('b')], window: [done('a'), done('b'), live('x')], expect: unchanged },
  { name: 'an equal board changes nothing', held: [done('a'), board('todo', 'alpha'), done('b')], window: [done('a'), done('b'), board('todo', 'alpha')], expect: unchanged },
  { name: 'an equal open live-only item changes nothing', held: [done('a'), liveOpen('x', 'typing')], window: [done('a'), liveOpen('x', 'typing')], expect: unchanged },

  // The window only adds at the end, so the journal appends and keeps its epoch.
  { name: 'one item after the last shared item is appended', held: [done('a')], window: [done('a'), done('b')], expect: extend(['b']) },
  { name: 'several items after the last shared item are appended in order, open ones too', held: [done('a')], window: [done('a'), done('b'), open('c', 'so far'), done('d')], expect: extend(['b', 'c', 'd']) },
  { name: 'an extension past a window that reaches further back is appended', held: [done('b')], window: [done('a'), done('b'), done('c')], expect: extend(['c']) },
  { name: 'an extension after an open item with the same content is appended', held: [done('a'), open('b', 'so far')], window: [done('a'), open('b', 'so far'), done('c')], expect: extend(['c']) },
  { name: 'a live-only item with a new key is appended', held: [done('a')], window: [done('a'), live('x')], expect: extend(['x']) },
  { name: 'a live-only item with a new key before the shared items is appended', held: [done('a'), done('b')], window: [live('x'), done('a'), done('b')], expect: extend(['x']) },
  { name: 'a live-only item with a new key is appended with the native items after it, in window order', held: [done('a')], window: [done('a'), board('todo', 'alpha'), done('b')], expect: extend(['todo', 'b']) },
  { name: 'a live-only item alone is appended to a journal that holds no native item', held: [], window: [live('x')], expect: extend(['x']) },
  { name: 'an extension next to a held live-only item is appended', held: [done('a'), live('x')], window: [done('a'), live('x'), done('b')], expect: extend(['b']) },
  { name: 'a changed tool call is rewritten in place', held: [done('a'), tool('t', 'running')], window: [done('a'), tool('t', 'finished')], expect: extend([], ['t']) },
  { name: 'a changed board is rewritten in place', held: [done('a'), board('todo', 'alpha'), done('b')], window: [done('a'), done('b'), board('todo', 'beta')], expect: extend([], ['todo']) },
  { name: 'a rewrite in place and an extension are one append', held: [done('a'), board('todo', 'alpha')], window: [done('a'), done('b'), board('todo', 'beta')], expect: extend(['b'], ['todo']) },
  { name: 'an extension that fits the room is appended', held: [done('a')], window: [done('a'), done('b')], room: { resident: 100, roomBytes: 100_000 }, expect: extend(['b']) },

  // Anything else replaces the journal with a new epoch, and the reason says what differed first.
  { name: 'a window over a journal with no native item is a replacement: new', held: [], window: [done('a'), done('b')], expect: replace('new') },
  { name: 'a window over a journal that holds only live-only items is a replacement: new', held: [live('x')], window: [done('a')], expect: replace('new') },
  { name: 'a journal that is missing rows is replaced even by an equal window', held: [done('a'), done('b')], window: [done('a'), done('b')], incomplete: true, expect: replace('incomplete') },
  { name: 'a journal that is missing rows is replaced by an empty window', held: [done('a')], window: [], incomplete: true, expect: replace('incomplete') },
  { name: 'an empty window over a journal that has native items is a replacement: changed', held: [done('a')], window: [], expect: replace('changed') },
  { name: 'a complete item with another digest is a replacement: changed', held: [done('a', 'first')], window: [done('a', 'second')], expect: replace('changed') },
  { name: 'a complete item the window lacks is a replacement: changed', held: [done('a'), done('b'), done('c')], window: [done('a'), done('c')], expect: replace('changed') },
  { name: 'items in another order are a replacement: changed', held: [done('a'), done('b')], window: [done('b'), done('a')], expect: replace('changed') },
  { name: 'a new item inside the window is a replacement: changed', held: [done('a'), done('c')], window: [done('a'), done('b'), done('c')], expect: replace('changed') },
  { name: 'a window that shares no key with the journal is a replacement: changed', held: [done('a')], window: [done('x'), done('y')], expect: replace('changed') },
  { name: 'a native item before the first shared key, with older items held, is a replacement: changed', held: [done('a'), done('b'), done('c')], window: [done('x'), done('b'), done('c')], expect: replace('changed') },
  { name: 'a complete item that is open in the window is a replacement: open_item', held: [done('a')], window: [open('a')], expect: replace('open_item') },
  { name: 'an open item that is complete in the window is a replacement: open_item', held: [open('a', 'so far')], window: [done('a', 'so far')], expect: replace('open_item') },
  { name: 'an open item with other content is a replacement: open_item', held: [open('a', 'so far')], window: [open('a', 'more')], expect: replace('open_item') },
  { name: 'an open item whose body was evicted is a replacement: open_item', held: [evicted(open('a', 'so far'))], window: [open('a', 'so far')], expect: replace('open_item') },
  { name: 'a first difference at an open item is a replacement: open_item', held: [done('a'), open('b', 'so far')], window: [done('a'), done('c')], expect: replace('open_item') },
  { name: 'a key that is live-only in the journal and native in the window is a replacement: changed', held: [done('a'), live('b')], window: [done('a'), done('b')], expect: replace('changed') },
  { name: 'a key that is native in the journal and live-only in the window is a replacement: changed', held: [done('a'), done('b')], window: [done('a'), live('b')], expect: replace('changed') },
  { name: 'a live-only item with other content that cannot be rewritten is a replacement: changed', held: [done('a'), live('x', 'first')], window: [done('a'), live('x', 'second')], expect: replace('changed') },
  { name: 'an open live-only item with other content is a replacement: open_item', held: [done('a'), liveOpen('x', 'typing')], window: [done('a'), liveOpen('x', 'typed')], expect: replace('open_item') },
  { name: 'a live-only item whose body was evicted is a replacement: changed', held: [done('a'), evicted(tool('t', 'running'))], window: [done('a'), tool('t', 'running')], expect: replace('changed') },
  { name: 'a live-only item that changes kind is a replacement: changed', held: [done('a'), tool('x', 'same')], window: [done('a'), board('x', 'same')], expect: replace('changed') },
  { name: 'an extension of any size is appended when no room is given', held: [done('a')], window: [done('a'), done('b', 'x'.repeat(1_000_000))], expect: extend(['b']) },
  { name: 'an extension that does not fit the room is a replacement: changed', held: [done('a')], window: [done('a'), done('b')], room: { resident: 100, roomBytes: 150 }, expect: replace('changed') },

  // A provider whose reread may permute the siblings of one turn (`siblings_unordered`): the Relay compares each turn's siblings as a set.
  { name: 'the siblings of a turn read again in another order change nothing when the provider reads them unordered', order: 'siblings_unordered',
    held: [...inTurn('t1', 'a'), ...inTurn('t2', 'b', 'c')], window: [...inTurn('t1', 'a'), ...inTurn('t2', 'c', 'b')], expect: unchanged },
  { name: 'the siblings of a turn read again in another order are a replacement when the provider keeps the live order: changed',
    held: [...inTurn('t1', 'a'), ...inTurn('t2', 'b', 'c')], window: [...inTurn('t1', 'a'), ...inTurn('t2', 'c', 'b')], expect: replace('changed') },
  { name: 'unordered siblings keep the turn the journal holds for them, whatever turn the window names', order: 'siblings_unordered',
    held: [...inTurn('t1', 'a'), ...inTurn('t2', 'b', 'c')], window: [...inTurn('t1', 'a'), ...inTurn('x', 'c'), ...inTurn('y', 'b')], expect: unchanged },
  { name: 'a new sibling among unordered siblings read again is appended', order: 'siblings_unordered',
    held: [...inTurn('t1', 'a', 'b')], window: [...inTurn('t1', 'b', 'x', 'a')], expect: extend(['x']) },
  { name: 'turns read again in another order are a replacement even when siblings are unordered: changed', order: 'siblings_unordered',
    held: [...inTurn('t1', 'a'), ...inTurn('t2', 'b', 'c')], window: [...inTurn('t2', 'b', 'c'), ...inTurn('t1', 'a')], expect: replace('changed') },
  { name: 'an unordered sibling with another digest is a replacement: changed', order: 'siblings_unordered',
    held: [...inTurn('t1', 'a', 'b')], window: [{ key: 'b', turn: 't1', text: 'other' }, ...inTurn('t1', 'a')], expect: replace('changed') },
];

/** The text an item has when the vector does not give one. */
export const vectorText = (item: VectorItem): string => item.text ?? item.key;

/** The content of an item as its journal row and its timeline entry hold it. */
export function vectorContent(item: VectorItem): AgentTimelineItem {
  const text = vectorText(item);
  switch (item.kind ?? 'message') {
    case 'tool': return { type: 'tool_call', callId: item.key, name: 'shell', status: 'completed', error: null, detail: { type: 'other', description: text } };
    case 'board': return { type: 'todo', items: [{ text, completed: false }] };
    default: return { type: 'assistant_message', text, messageId: item.key };
  }
}

/** The digest of a complete item. The default follows the text, so equal text is an equal digest. */
export type VectorDigest = (item: VectorItem) => string;
const textDigest: VectorDigest = item => `digest:${item.key}:${vectorText(item)}`;

/** The window as a Controller offers it. */
export function windowItems(vector: WindowVector, digestOf: VectorDigest = textDigest): JournalItemInput[] {
  return vector.window.map(item => ({
    row: {
      itemKey: item.key, providerId: 'codex', sourceKey: `source-${item.key}`, occurredAt: 1_725_000_000_000, turnId: item.turn ?? 'turn-1',
      item: vectorContent(item), ...(item.live ? { liveOnly: true } : {}),
    },
    ...(item.state === 'open' ? {} : { digest: digestOf(item) }),
  }));
}

/** What the journal holds, as the decision reads it. */
export function heldTail(vector: WindowVector, digestOf: VectorDigest = textDigest): WindowTail {
  const items = vector.held.map((item, at): JournalItem => ({
    itemKey: item.key, providerId: 'codex', turnId: item.turn ?? 'turn-1', seqStart: at + 1, seqEnd: at + 1, sourceSeqRanges: [{ startSeq: at + 1, endSeq: at + 1 }],
    state: item.state ?? 'complete', ...(item.state === 'open' ? {} : { digest: digestOf(item) }), liveOnly: item.live === true,
    body: item.evicted ? null : { item: vectorContent(item), timestamp: '2024-08-30T06:40:00.000Z', collapsed: [], resources: [] },
  }));
  return { items, byKey: new Map(items.map(item => [item.itemKey, item])), incomplete: vector.incomplete === true, residentBytes: () => vector.room?.resident ?? 0 };
}

/** A decision in the form a vector writes it: the keys of an extension in window order, and no update list when it is empty. */
export function describeDecision(decision: WindowDecision, window: readonly JournalItemInput[]): VectorExpectation {
  if (decision.outcome !== 'extend') return decision;
  const keys = window.map(({ row }) => row.itemKey);
  const append = keys.filter(key => decision.append.has(key));
  const update = keys.filter(key => decision.update.has(key));
  return { outcome: 'extend', append, ...(update.length === 0 ? {} : { update }) };
}
