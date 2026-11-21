import { Type, type Static } from '@sinclair/typebox';

import { BackgroundActivity } from './background-activity.js';
import { SafeNonNegativeInteger, TimelineCursor } from './cursor.js';
import { ResourceBinding } from './resources.js';
import { AgentSnapshotPayload } from './snapshot.js';
import { AgentTimelineItem } from './timeline.js';
import { UPLINK_MAX_FRAME_BYTES } from './uplink.js';

/**
 * Session journals over the Host uplink. A Controller that asked for them (`journal=1`, acknowledged by
 * `registered.journal`) opens a session's journal, which fences every older connection of that session, publishes
 * entries under the generation it was given, and answers the Relay's requests to read bodies and older history again.
 * The Relay acknowledges a publication only once its store holds it. The messages are listed without their envelope
 * (`uplinkVersion`, `type`), which remote-host-uplink.ts adds.
 */

/** The one journal version: a Controller asks for it with `journal=1` and the Relay acknowledges it in `registered.journal`. */
export const JOURNAL_VERSION = 1;
/** The most entries one publication carries. */
export const JOURNAL_PUBLISH_MAX_ENTRIES = 256;
/** The most UTF-8 bytes of any journal message. */
export const JOURNAL_MESSAGE_MAX_BYTES = UPLINK_MAX_FRAME_BYTES / 4;
/** The most items one window or prepend carries. */
export const JOURNAL_ITEMS_PER_ENTRY_MAX = 5000;
/** The most bodies one fill carries or asks for. */
export const JOURNAL_FILL_MAX_ITEMS = 64;
/** The most items one older-history read asks for. */
export const JOURNAL_OLDER_MAX_LIMIT = 200;
/** The most sessions one `journal_shown` names: as many as a Relay binds. */
export const JOURNAL_SHOWN_MAX_SESSIONS = 4096;

const object = { additionalProperties: false } as const;
const identity = Type.String({ minLength: 1, maxLength: 512 });
const requestId = identity;
/** `${providerId}:${nativeSessionId}`. */
const sessionKey = Type.String({ minLength: 1, maxLength: 4609 });
const itemKey = Type.String({ minLength: 1, maxLength: 4096 });
const digest = Type.String({ minLength: 1, maxLength: 128 });
const generation = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
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

/**
 * The Controller's latest Snapshot. Its `attention.cursor` is stated in the Controller's own timeline, which the journal
 * does not share; `attentionItemKey` names the item that cursor points at, and the journal serves the cursor of that item
 * in its own epoch and sequence.
 */
export const JournalHead = Type.Object({ snapshot: AgentSnapshotPayload, observedAt: milliseconds, attentionItemKey: Type.Optional(itemKey) }, object);
export type JournalHead = Static<typeof JournalHead>;

const sequence = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** An item of a replacement or a prepend: one row carrying its whole content, and its digest unless the item is still open. */
export const JournalItemInput = Type.Object({ row: JournalRowInput, digest: Type.Optional(digest) }, object);
export type JournalItemInput = Static<typeof JournalItemInput>;
const items = Type.Array(JournalItemInput, { maxItems: JOURNAL_ITEMS_PER_ENTRY_MAX });
export const JournalPublishEntry = Type.Union([
  Type.Object({ sequence, op: Type.Literal('append'), row: JournalRowInput }, object),
  Type.Object({ sequence, op: Type.Literal('complete'), itemKey, digest }, object),
  Type.Object({ sequence, op: Type.Literal('alias'), itemKey, clientMessageId: identity }, object),
  /** The Controller's newest window of native history, oldest first. The Relay compares it with the journal and leaves it, appends to it or replaces it. */
  Type.Object({ sequence, op: Type.Literal('window'), items }, object),
  Type.Object({ sequence, op: Type.Literal('prepend'), items }, object),
  Type.Object({ sequence, op: Type.Literal('head'), head: JournalHead }, object),
  /** A resource binding of an item was replaced; the journal replaces it in place and tells subscribers. */
  Type.Object({ sequence, op: Type.Literal('rebind'), itemKey, previous: ResourceBinding, replacement: ResourceBinding }, object),
  /** A background outcome; the journal applies it in place to every item it concerns and tells subscribers. */
  Type.Object({ sequence, op: Type.Literal('outcome'), providerId: identity, turnId: Type.Optional(identity), background: BackgroundActivity, occurredAt: milliseconds }, object),
]);
export type JournalPublishEntry = Static<typeof JournalPublishEntry>;

export const JOURNAL_REFUSAL_REASONS = ['fenced', 'invalid', 'quota_exceeded', 'incomplete', 'sequence_gap'] as const;
export const JournalRefusalReason = Type.Union(JOURNAL_REFUSAL_REASONS.map(reason => Type.Literal(reason)));
export type JournalRefusalReason = (typeof JOURNAL_REFUSAL_REASONS)[number];

/** Host to Relay. */
export const JournalOpen = Type.Object({ requestId, sessionKey, publisherId: identity }, object);
export const JournalPublish = Type.Object({ sessionKey, generation, entries: Type.Array(JournalPublishEntry, { minItems: 1, maxItems: JOURNAL_PUBLISH_MAX_ENTRIES }) }, object);
export const JournalFill = Type.Object({ requestId, sessionKey, items: Type.Array(CompleteItemInput, { maxItems: JOURNAL_FILL_MAX_ITEMS }) }, object);
export const JournalOlderDone = Type.Object({ requestId, sessionKey, olderAvailable: Type.Boolean() }, object);
/**
 * The Controller can no longer keep the session's journal current, and says so: the Relay clears the journal's head, so
 * the session is read through the Controller again until a later publication sets a head. `generation` is the one the
 * Controller opened the journal with; an older one is ignored.
 */
export const JournalUnserve = Type.Object({ sessionKey, generation }, object);
export const JOURNAL_REQUEST_REFUSAL_REASONS = ['not_followed', 'not_ready'] as const;
export type JournalRequestRefusalReason = (typeof JOURNAL_REQUEST_REFUSAL_REASONS)[number];
/** The Controller cannot answer a fill or an older-history request: it does not follow the session, or has not opened its journal yet. */
export const JournalRequestRefused = Type.Object({ requestId, sessionKey, reason: Type.Union(JOURNAL_REQUEST_REFUSAL_REASONS.map(reason => Type.Literal(reason))) }, object);
/** Relay to Host. */
/** The journal is open: the Controller publishes under `generation`, resuming after `watermark`. */
export const JournalOpened = Type.Object({ requestId, sessionKey, generation, watermark: SafeNonNegativeInteger }, object);
export const JOURNAL_OPEN_REFUSAL_REASONS = ['unavailable'] as const;
export type JournalOpenRefusalReason = (typeof JOURNAL_OPEN_REFUSAL_REASONS)[number];
/** The Relay could not open the session's journal: no generation was claimed and the session stays unopened. */
export const JournalOpenRefused = Type.Object({ requestId, sessionKey, reason: Type.Union(JOURNAL_OPEN_REFUSAL_REASONS.map(reason => Type.Literal(reason))) }, object);
export const JournalAck = Type.Object({ sessionKey, generation, watermark: SafeNonNegativeInteger, cursor: TimelineCursor }, object);
export const JournalRefused = Type.Object({ sessionKey, generation, sequence: SafeNonNegativeInteger, reason: JournalRefusalReason }, object);
export const JournalFillRequest = Type.Object({ requestId, sessionKey, itemKeys: Type.Array(itemKey, { minItems: 1, maxItems: JOURNAL_FILL_MAX_ITEMS }) }, object);
/** `beforeItemKey` is the journal's oldest item that is not live-only: the Controller answers with the complete items older than it. */
export const JournalOlderRequest = Type.Object({ requestId, sessionKey, beforeItemKey: itemKey, limit: Type.Integer({ minimum: 1, maximum: JOURNAL_OLDER_MAX_LIMIT }) }, object);
/**
 * The sessions of this Host that pages show now: each has a page reading its conversation from the journal. The set is complete and
 * replaces the one before; the Relay sends it when the Controller registers and whenever it changes, to a Controller that asked for it
 * (`journalShown=1`). The Controller keeps a shown session attached, so its CLI's events keep reaching the page.
 */
export const JournalShown = Type.Object({ sessionKeys: Type.Array(sessionKey, { maxItems: JOURNAL_SHOWN_MAX_SESSIONS }) }, object);

const encoder = new (globalThis as unknown as { TextEncoder: new () => { encode(value: string): Uint8Array } }).TextEncoder();
const distinct = (keys: readonly string[]) => new Set(keys).size === keys.length;

/** The rules the schemas cannot state: size, strictly increasing entries and distinct items. */
export function validJournalMessage(message: { type: string }): boolean {
  if (encoder.encode(JSON.stringify(message)).length > JOURNAL_MESSAGE_MAX_BYTES) return false;
  switch (message.type) {
    case 'journal_publish': {
      const { entries } = message as unknown as Static<typeof JournalPublish>;
      return entries.every((entry, at) => at === 0 || entry.sequence > entries[at - 1]!.sequence);
    }
    case 'journal_fill': return distinct((message as unknown as Static<typeof JournalFill>).items.map(({ row }) => row.itemKey));
    case 'journal_fill_request': return distinct((message as unknown as Static<typeof JournalFillRequest>).itemKeys);
    case 'journal_shown': return distinct((message as unknown as Static<typeof JournalShown>).sessionKeys);
    default: return true;
  }
}
