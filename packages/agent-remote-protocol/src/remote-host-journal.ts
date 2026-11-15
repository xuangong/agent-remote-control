import { Type, type Static } from '@sinclair/typebox';

import { SafeNonNegativeInteger, SafeTimelinePosition, TimelineCursor } from './cursor.js';
import { ResourceBinding } from './resources.js';
import { AgentSnapshotPayload } from './snapshot.js';
import { AgentTimelineItem } from './timeline.js';
import { UPLINK_MAX_FRAME_BYTES } from './uplink.js';

/**
 * Session journals over the Host uplink. A Controller that asked for them (`journal=1`, acknowledged by
 * `registered.journal: 1`) opens a session's journal, which fences every older connection of that session, publishes
 * entries under the generation it was given, and answers the Relay's requests to read bodies and older history again.
 * The Relay acknowledges a publication only once its store holds it. The messages are listed without their envelope
 * (`uplinkVersion`, `type`), which remote-host-uplink.ts adds.
 */

/** The most entries one publication carries. */
export const JOURNAL_PUBLISH_MAX_ENTRIES = 256;
/** The most UTF-8 bytes of any journal message. */
export const JOURNAL_MESSAGE_MAX_BYTES = UPLINK_MAX_FRAME_BYTES / 4;
/** The most items one replacement or prepend carries. */
export const JOURNAL_ITEMS_PER_ENTRY_MAX = 5000;
/** The most items an index lists, across `journal_opened` and the `journal_index_page` messages the Controller asks for. */
export const JOURNAL_INDEX_MAX_ITEMS = 100_000;
/** The most items one message of an index carries. */
export const JOURNAL_INDEX_PAGE_MAX_ITEMS = 2000;
/** The most bodies one fill carries or asks for. */
export const JOURNAL_FILL_MAX_ITEMS = 64;
/** The most items one older-history read asks for. */
export const JOURNAL_OLDER_MAX_LIMIT = 200;

const object = { additionalProperties: false } as const;
const identity = Type.String({ minLength: 1, maxLength: 512 });
const requestId = identity;
/** `${providerId}:${nativeSessionId}`. */
const sessionKey = Type.String({ minLength: 1, maxLength: 4609 });
const itemKey = Type.String({ minLength: 1, maxLength: 4096 });
const digest = Type.String({ minLength: 1, maxLength: 128 });
const generation = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** A time `Date` can represent. */
const milliseconds = Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 });

/** One row a Controller publishes: a timeline row plus the native identity of the item it belongs to. */
export const JournalRowInput = Type.Object({
  itemKey, providerId: identity, sourceKey: itemKey,
  nativeRevision: Type.Optional(SafeNonNegativeInteger), occurredAt: milliseconds, turnId: Type.Optional(identity),
  item: AgentTimelineItem, resources: Type.Optional(Type.Array(ResourceBinding, { maxItems: 256 })),
  /** A row that a reread of native history cannot reproduce. */
  liveOnly: Type.Optional(Type.Boolean()),
}, object);
export type JournalRowInput = Static<typeof JournalRowInput>;

/** A complete item from native history: one row carrying its whole content, and its digest. */
export const CompleteItemInput = Type.Object({ row: JournalRowInput, digest }, object);
export type CompleteItemInput = Static<typeof CompleteItemInput>;

export const JournalIndexEntry = Type.Object({
  itemKey, seqStart: SafeTimelinePosition, seqEnd: SafeTimelinePosition,
  state: Type.Union([Type.Literal('open'), Type.Literal('complete')]),
  digest: Type.Optional(digest), liveOnly: Type.Boolean(), clientMessageId: Type.Optional(identity),
  revision, resident: Type.Boolean(),
}, object);
export type JournalIndexEntry = Static<typeof JournalIndexEntry>;

export const JournalHead = Type.Object({ snapshot: AgentSnapshotPayload, observedAt: milliseconds }, object);
export type JournalHead = Static<typeof JournalHead>;

const sequence = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const items = Type.Array(CompleteItemInput, { maxItems: JOURNAL_ITEMS_PER_ENTRY_MAX });
export const JournalPublishEntry = Type.Union([
  Type.Object({ sequence, op: Type.Literal('append'), row: JournalRowInput }, object),
  Type.Object({ sequence, op: Type.Literal('complete'), itemKey, digest }, object),
  Type.Object({ sequence, op: Type.Literal('seal'), itemKey }, object),
  Type.Object({ sequence, op: Type.Literal('alias'), itemKey, clientMessageId: identity }, object),
  Type.Object({ sequence, op: Type.Literal('correct'), row: JournalRowInput, digest, expectedRevision: revision }, object),
  Type.Object({ sequence, op: Type.Literal('replace'), items }, object),
  Type.Object({ sequence, op: Type.Literal('prepend'), items }, object),
  Type.Object({ sequence, op: Type.Literal('head'), head: JournalHead }, object),
]);
export type JournalPublishEntry = Static<typeof JournalPublishEntry>;

export const JOURNAL_REFUSAL_REASONS = ['fenced', 'stale_revision', 'unknown_item', 'body_missing', 'type_changed', 'duplicate_item', 'invalid', 'quota_exceeded'] as const;
export const JournalRefusalReason = Type.Union(JOURNAL_REFUSAL_REASONS.map(reason => Type.Literal(reason)));
export type JournalRefusalReason = (typeof JOURNAL_REFUSAL_REASONS)[number];

/** Host to Relay. */
export const JournalOpen = Type.Object({ requestId, sessionKey, publisherId: identity }, object);
export const JournalPublish = Type.Object({ sessionKey, generation, entries: Type.Array(JournalPublishEntry, { minItems: 1, maxItems: JOURNAL_PUBLISH_MAX_ENTRIES }) }, object);
export const JournalFill = Type.Object({ requestId, sessionKey, items: Type.Array(CompleteItemInput, { maxItems: JOURNAL_FILL_MAX_ITEMS }) }, object);
export const JournalOlderDone = Type.Object({ requestId, sessionKey, olderAvailable: Type.Boolean() }, object);
/** Asks for the entries of the index of epoch `epoch` after `after`, a `seqStart`; sent for the `indexAfter` of the last page, one request at a time. */
export const JournalIndexRequest = Type.Object({ requestId, sessionKey, generation, epoch: identity, after: SafeTimelinePosition }, object);

/** Relay to Host. */
/**
 * The journal is open. `index` is the first page of the item index. When the index does not fit it, `indexAfter` is the
 * `seqStart` of the last entry sent and the Controller pulls the rest with `journal_index_request`; the journal is open for
 * the Controller after the last page. `indexAfter` is absent when `index` is the whole index.
 */
export const JournalOpened = Type.Object({ requestId, sessionKey, generation, watermark: SafeNonNegativeInteger, epoch: identity,
  index: Type.Array(JournalIndexEntry, { maxItems: JOURNAL_INDEX_MAX_ITEMS }), indexAfter: Type.Optional(SafeTimelinePosition) }, object);
/** The answer to a `journal_index_request`: the next entries in order, and `indexAfter` when more follow. */
export const JournalIndexPage = Type.Object({ requestId, sessionKey,
  index: Type.Array(JournalIndexEntry, { maxItems: JOURNAL_INDEX_PAGE_MAX_ITEMS }), indexAfter: Type.Optional(SafeTimelinePosition) }, object);
export const JOURNAL_OPEN_REFUSAL_REASONS = ['index_too_large', 'invalid', 'stale_epoch'] as const;
export type JournalOpenRefusalReason = (typeof JOURNAL_OPEN_REFUSAL_REASONS)[number];
/** The Relay could not open the session's journal: no generation was claimed and the session stays unopened. */
export const JournalOpenRefused = Type.Object({ requestId, sessionKey, reason: Type.Union(JOURNAL_OPEN_REFUSAL_REASONS.map(reason => Type.Literal(reason))) }, object);
export const JournalAck = Type.Object({ sessionKey, generation, watermark: SafeNonNegativeInteger, cursor: TimelineCursor }, object);
export const JournalRefused = Type.Object({ sessionKey, generation, sequence: SafeNonNegativeInteger, reason: JournalRefusalReason, itemKey: Type.Optional(itemKey) }, object);
export const JournalFillRequest = Type.Object({ requestId, sessionKey, itemKeys: Type.Array(itemKey, { minItems: 1, maxItems: JOURNAL_FILL_MAX_ITEMS }) }, object);
export const JournalOlderRequest = Type.Object({ requestId, sessionKey, limit: Type.Integer({ minimum: 1, maximum: JOURNAL_OLDER_MAX_LIMIT }) }, object);

const encoder = new (globalThis as unknown as { TextEncoder: new () => { encode(value: string): Uint8Array } }).TextEncoder();
const distinct = (keys: readonly string[]) => new Set(keys).size === keys.length;

/** One page of an index: well-ordered ranges, strictly increasing `seqStart`, and a cursor that is the last entry's `seqStart`, which needs an entry. */
function validIndexPage({ index, indexAfter }: { index: readonly JournalIndexEntry[]; indexAfter?: number }): boolean {
  if (!index.every((entry, at) => entry.seqStart <= entry.seqEnd && (at === 0 || entry.seqStart > index[at - 1]!.seqStart))) return false;
  return indexAfter === undefined || (index.length > 0 && indexAfter === index[index.length - 1]!.seqStart);
}

/** The rules the schemas cannot state: size, strictly increasing entries, distinct items and well-ordered ranges. */
export function validJournalMessage(message: { type: string }): boolean {
  if (encoder.encode(JSON.stringify(message)).length > JOURNAL_MESSAGE_MAX_BYTES) return false;
  switch (message.type) {
    case 'journal_publish': {
      const { entries } = message as unknown as Static<typeof JournalPublish>;
      return entries.every((entry, at) => at === 0 || entry.sequence > entries[at - 1]!.sequence);
    }
    case 'journal_fill': return distinct((message as unknown as Static<typeof JournalFill>).items.map(({ row }) => row.itemKey));
    case 'journal_fill_request': return distinct((message as unknown as Static<typeof JournalFillRequest>).itemKeys);
    case 'journal_opened': return validIndexPage(message as unknown as Static<typeof JournalOpened>);
    case 'journal_index_page': return validIndexPage(message as unknown as Static<typeof JournalIndexPage>);
    default: return true;
  }
}
