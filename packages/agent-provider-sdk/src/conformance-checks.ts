import { readUnknownNativeEvent } from './native-events.js';
import { AgentSessionInUseError } from './provider.js';
import type { AgentLiveOnlyKind, AgentProviderBehaviour, AgentRereadBehaviour } from './behaviour.js';
import type { JournalRecording } from './journal-recording.js';
import type { AgentRuntimeInfo, AgentStreamEvent, ProviderObservation } from './observation.js';

/**
 * The checks of the provider conformance kit (`conformance.ts`), as pure functions over what an adapter emitted. Each returns its
 * findings: one sentence per broken rule, naming the declared field the adapter contradicts, and none when the adapter conforms. They
 * read recordings of the real CLI and the plays of an adapter's native fake; they never start a process or read a clock.
 *
 * Rules.
 * - K1 Reread order: a reread lists the native items it shares with the live run in the live order, or, for an adapter that declares
 *   `reread.order` `siblings_unordered`, lists the same turns in the live order with the siblings of each turn in any order.
 * - K2 Identity: every timeline and `interaction_resolved` observation carries an item identity whose key is not empty, at most 4096
 *   characters, and not under the `controller:` prefix the Controller keeps; a reread names no item the live run did not show, and
 *   finishes every item it names but a tool the CLI left running, since native history holds finished items.
 * - K3 Live-only kinds: every item marked live-only is of a type that a declared `liveOnly` kind names.
 * - K4 Input identity: an adapter that declares `input.identity` `echoes_client_id` reports the client's input id as the user row's
 *   `clientMessageId`, live and when history is read again.
 * - K5 Usage limit: an adapter that declares a limit signal and types `native_usage_limited` fails the turn the CLI's signal stops with
 *   that code and reports `runtimeInfo.usageLimit`, with the reset time when the CLI gives one; one that types it not fails it untyped.
 * - K6 Writer elsewhere: an adapter that declares the `failures.inUse` reason `writer_elsewhere` raises the CLI's refusal of a second
 *   writer as `AgentSessionInUseError` with that reason.
 * - K7 Unknown native events (gap 10, `native-events.ts`): an event of a kind the adapter does not know is one diagnostic
 *   (`native_event_unknown`) each time it arrives, never a row and never a silent drop.
 */

/** One item of a recorded side, in the order items first appear, as the journal groups rows: its key, type, turn and marks. */
export interface RecordedItem {
  key: string;
  /** The timeline item's type; `interaction` for an `interaction_resolved` observation, from which the Controller builds one. */
  type: string;
  /** The turn of its first observation. */
  turnId?: string;
  liveOnly: boolean;
}

/** The items observations hold, keyed by item identity, in the order each first appears. */
export function recordedItems(observations: readonly ProviderObservation[]): RecordedItem[] {
  const items = new Map<string, RecordedItem>();
  for (const { event, itemIdentity } of observations) {
    if (!itemIdentity) continue;
    const held = items.get(itemIdentity.key);
    if (held) { if (itemIdentity.liveOnly) held.liveOnly = true; continue; }
    const type = event.type === 'timeline' ? event.item.type : event.type === 'interaction_resolved' ? 'interaction' : event.type;
    items.set(itemIdentity.key, { key: itemIdentity.key, type, ...('turnId' in event && event.turnId !== undefined ? { turnId: event.turnId } : {}), liveOnly: itemIdentity.liveOnly === true });
  }
  return [...items.values()];
}

/** Consecutive items of one turn form one group; an item without a turn is a group of its own. */
function turnGroups(items: readonly RecordedItem[]): string[][] {
  const groups: Array<{ turnId?: string; keys: string[] }> = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && item.turnId !== undefined && last.turnId === item.turnId) last.keys.push(item.key);
    else groups.push({ ...(item.turnId === undefined ? {} : { turnId: item.turnId }), keys: [item.key] });
  }
  return groups.map(({ keys }) => keys);
}

/**
 * K1: the reread's native items against the live run's, in the order `reread.order` declares. The siblings of a turn are the consecutive
 * items the live run gave one turn: the turn the journal holds for them, whatever turn the reread names.
 */
export function rereadOrderFindings(name: string, recording: JournalRecording, order: AgentRereadBehaviour['order']): string[] {
  const live = recordedItems(recording.live).filter(item => !item.liveOnly);
  const reread = recordedItems(recording.reread).filter(item => !item.liveOnly);
  const inLive = new Set(live.map(({ key }) => key)), inReread = new Set(reread.map(({ key }) => key));
  const liveShared = live.filter(({ key }) => inReread.has(key));
  const expected = liveShared.map(({ key }) => key), actual = reread.filter(({ key }) => inLive.has(key)).map(({ key }) => key);
  if (order === 'siblings_unordered') {
    // The same keys on both sides: the reread only permutes siblings when the turns of its items never go back.
    const turnOf = new Map(turnGroups(liveShared).flatMap((keys, at) => keys.map(key => [key, at] as const)));
    const turns = actual.map(key => turnOf.get(key)!);
    if (turns.every((turn, at) => at === 0 || turn >= turns[at - 1]!)) return [];
  } else if (JSON.stringify(actual) === JSON.stringify(expected)) return [];
  return [`reread.order '${order}': ${name} reads its items again as [${actual.join(' ')}], where the live run showed [${expected.join(' ')}]`];
}

const KEY_MAX = 4096;

/** K2: every row has a usable identity, and a reread adds no item. */
export function identityFindings(name: string, recording: JournalRecording): string[] {
  const findings: string[] = [];
  for (const side of ['live', 'reread'] as const) {
    for (const { event, itemIdentity, sourceKey } of recording[side]) {
      if (event.type !== 'timeline' && event.type !== 'interaction_resolved') continue;
      const key = itemIdentity?.key;
      if (key === undefined) findings.push(`identity: ${name} (${side}) emits ${sourceKey}, a ${event.type} observation without an item identity`);
      else if (key === '' || key.length > KEY_MAX || key.startsWith('controller:')) findings.push(`identity: ${name} (${side}) keys an item '${key.slice(0, 80)}', which a journal cannot hold`);
    }
  }
  const live = new Set(recordedItems(recording.live).map(({ key }) => key));
  const added = recordedItems(recording.reread).filter(({ key }) => !live.has(key)).map(({ key }) => key);
  if (added.length > 0) findings.push(`identity: a reread of ${name} names items the live run did not show: ${added.join(', ')}`);
  const finished = new Set(recording.reread.flatMap(({ itemIdentity }) => itemIdentity?.completes ? [itemIdentity.key] : []));
  const open = recordedItems(recording.reread).filter(({ key, type }) => type !== 'tool_call' && !finished.has(key)).map(({ key }) => key);
  if (open.length > 0) findings.push(`identity: a reread of ${name} leaves items open, which native history holds finished: ${open.join(', ')}`);
  return findings;
}

/** The timeline item type each live-only kind names. */
export const LIVE_ONLY_ITEM_TYPES: Readonly<Record<AgentLiveOnlyKind, string>> = Object.freeze({
  interaction: 'interaction', todo: 'todo', error: 'error', startup_notice: 'error', reasoning: 'reasoning',
  synthetic_output: 'assistant_message', partial_output: 'assistant_message',
});

/** K3: the items the recordings mark live-only are of declared kinds. */
export function liveOnlyFindings(recordings: ReadonlyArray<readonly [string, JournalRecording]>, declared: readonly AgentLiveOnlyKind[]): string[] {
  const covered = new Set(declared.map(kind => LIVE_ONLY_ITEM_TYPES[kind]));
  const undeclared = new Map<string, string>();
  for (const [name, recording] of recordings) {
    for (const item of [...recordedItems(recording.live), ...recordedItems(recording.reread)]) {
      if (item.liveOnly && !covered.has(item.type) && !undeclared.has(item.type)) undeclared.set(item.type, `${name} (${item.key})`);
    }
  }
  return [...undeclared].map(([type, where]) => `liveOnly [${declared.join(', ')}]: ${where} marks an item of type ${type} live-only, and no declared kind names that type`);
}

/** One turn an adapter's native fake plays (see `ProviderNativeFake.turn`). */
export interface ProviderNativeTurn {
  /** The journal observations of the session opened over one finished turn and running one more turn live: its history, then the live turn. */
  live: ProviderObservation[];
  /** The journal observations of the same native session opened again: its history. */
  reread: ProviderObservation[];
  /** The diagnostic lines the adapter reported meanwhile. */
  diagnostics: string[];
  /** How many events of a kind the adapter does not know the CLI sent. */
  unknownSent: number;
}

const userInputIds = (observations: readonly ProviderObservation[]): Array<string | undefined> => observations.flatMap(({ event }) =>
  event.type === 'timeline' && event.item.type === 'user_message' ? [event.item.clientMessageId] : []);

/** K4: the client's input id comes back with the user row, live and on a reread. */
export function inputIdentityFindings(turn: ProviderNativeTurn, inputId: string, identity: AgentProviderBehaviour['input']['identity']): string[] {
  if (identity !== 'echoes_client_id') return [];
  return (['live', 'reread'] as const).filter(side => !userInputIds(turn[side]).includes(inputId))
    .map(side => `input.identity 'echoes_client_id': the ${side} user row of a message sent with input id ${inputId} does not carry it as its clientMessageId`);
}

/** A turn the CLI's usage-limit signal stopped, as an adapter's native fake plays it. */
export interface ProviderNativeLimit {
  /** The events of the turn, in order. */
  events: AgentStreamEvent[];
  /** The session's runtime once the turn ended. */
  runtime: AgentRuntimeInfo;
  /** When the limit resets, in milliseconds since the epoch, as the CLI's signal says; absent when it says not. */
  resetsAt?: number;
}

/** K5: the CLI's limit signal fails the turn typed, and the runtime says when the limit resets. */
export function usageLimitFindings(limit: ProviderNativeLimit | undefined, behaviour: AgentProviderBehaviour): string[] {
  if (behaviour.limits.signal === 'none') return [];
  if (!limit) return [`limits.signal '${behaviour.limits.signal}': the native fake does not play the CLI's limit signal`];
  const failed = limit.events.find(event => event.type === 'turn_failed');
  const typed = behaviour.failures.runtime.includes('native_usage_limited');
  if (!failed || failed.type !== 'turn_failed') return [`limits.signal '${behaviour.limits.signal}': the turn the CLI's limit stopped did not fail`];
  if (!typed) return failed.code === 'native_usage_limited' ? ['failures.runtime: the adapter types native_usage_limited without declaring it'] : [];
  const findings: string[] = [];
  if (failed.code !== 'native_usage_limited') findings.push(`failures.runtime native_usage_limited: the turn the CLI's limit stopped failed with ${failed.code ?? 'no code'}`);
  if (!limit.runtime.usageLimit) findings.push('failures.runtime native_usage_limited: the runtime does not report the usage limit');
  else if (limit.runtime.usageLimit.resetsAt !== limit.resetsAt) findings.push(`failures.runtime native_usage_limited: the runtime says the limit resets at ${limit.runtime.usageLimit.resetsAt}, the CLI said ${limit.resetsAt}`);
  return findings;
}

/** K6: the CLI's refusal of a second writer is typed with its reason. */
export function writerElsewhereFindings(refusal: unknown, behaviour: AgentProviderBehaviour): string[] {
  if (!behaviour.failures.inUse.includes('writer_elsewhere')) return [];
  if (refusal instanceof AgentSessionInUseError && refusal.reason === 'writer_elsewhere') return [];
  const seen = refusal instanceof Error ? `${refusal.name}${refusal instanceof AgentSessionInUseError ? ` (${refusal.reason ?? 'no reason'})` : ''}` : String(refusal);
  return [`failures.inUse writer_elsewhere: the CLI's refusal of a second writer reached the Controller as ${seen}`];
}

/** What a turn shows, row by row, without the times and source keys a play draws afresh: kind, item type, identity and text. */
const rowShape = ({ event, itemIdentity }: ProviderObservation): string => [event.type, event.type === 'timeline' ? event.item.type : '', itemIdentity?.key ?? '',
  itemIdentity?.liveOnly ? 'live-only' : '', event.type === 'timeline' && 'text' in event.item ? event.item.text : ''].join('|');
const journalShape = (turn: ProviderNativeTurn) => JSON.stringify({ live: turn.live.map(rowShape), reread: turn.reread.map(rowShape) });

/** K7: the same turn with and without events the adapter does not know: the same rows, and one diagnostic for each such event. */
export function unknownEventFindings(providerId: string, withUnknown: ProviderNativeTurn, without: ProviderNativeTurn): string[] {
  const findings: string[] = [];
  if (withUnknown.unknownSent < 1) findings.push('unknown events: the native fake sent no event of a kind the adapter does not know');
  if (journalShape(withUnknown) !== journalShape(without)) findings.push(`unknown events: an event of a kind ${providerId} does not know changed the rows: ${journalShape(withUnknown)} instead of ${journalShape(without)}`);
  const reported = (turn: ProviderNativeTurn) => turn.diagnostics.flatMap(line => { const unknown = readUnknownNativeEvent(line); return unknown?.providerId === providerId ? [unknown] : []; });
  const seen = reported(withUnknown).length;
  if (seen !== withUnknown.unknownSent) findings.push(`unknown events: ${providerId} reported ${seen} diagnostics for ${withUnknown.unknownSent} events of a kind it does not know${seen < withUnknown.unknownSent ? ', so some were dropped silently' : ''}`);
  if (reported(without).length > 0) findings.push(`unknown events: ${providerId} reported events of a kind it does not know where the CLI sent none: ${reported(without).map(({ kind }) => kind).join(', ')}`);
  return findings;
}
