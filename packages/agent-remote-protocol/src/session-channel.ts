import { SessionSuccessionReplay } from './session-succession-replay.js';
import { SessionMigration } from './session-migration.js';
import { SessionStateHost, SessionStateRef, SessionStateUpdate, SESSION_STATE_LIMIT } from './session-states.js';
import { SessionRead, SessionReadsSince, SESSION_READ_LIMIT } from './session-reads.js';
import { SessionDraft, SESSION_DRAFT_LIMIT } from './session-drafts.js';
import { OutboxEntry, OUTBOX_HOST_LIMIT, OUTBOX_LIMIT } from './session-outbox.js';
import { type Static, Type } from '@sinclair/typebox';
import { ClientMessage, IncompatibleProtocolVersionErrorMessage, NegotiateRequest, ServerMessage } from './messages.js';
import { ProtocolVersionSchema } from './version.js';

const SubscriptionId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });

export const SessionChannelClientMessage = Type.Union([
  // idleMs: only on channels whose ready frame offered preemption; the subscription is not in use and was last in use idleMs ago.
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('subscribe'), subscriptionId: SubscriptionId, agentId: Type.String({ minLength: 1 }), message: NegotiateRequest,
    idleMs: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })) }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('message'), subscriptionId: SubscriptionId, message: ClientMessage }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('unsubscribe'), subscriptionId: SubscriptionId }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('ping') }),
  // Whether these subscriptions are in use: shown in the page's current Window, or observed by Track, while the page is visible.
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('intent'), active: Type.Boolean(),
    subscriptionIds: Type.Array(SubscriptionId, { minItems: 1, maxItems: 128 }) }),
]);
export type SessionChannelClientMessage = Static<typeof SessionChannelClientMessage>;

export const SessionTitleUpdate = Strict({ hostId: Type.String({ minLength: 1, maxLength: 512 }), providerId: Type.String({ minLength: 1, maxLength: 512 }),
  nativeSessionId: Type.String({ minLength: 1, maxLength: 4096 }), title: Type.String({ minLength: 1, maxLength: 512 }), revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) });
export type SessionTitleUpdate = Static<typeof SessionTitleUpdate>;

export const SessionChannelServerMessage = Type.Union([
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('session_succession_committed'), succession: SessionSuccessionReplay }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('session_title_updated'), session: SessionTitleUpdate }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('session_migrated'), migration: SessionMigration }),
  // Only on channels that requested states. A snapshot replaces everything known before; other frames change the listed entries.
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('session_states'), snapshot: Type.Optional(Type.Literal(true)),
    hosts: Type.Optional(Type.Array(SessionStateHost, { maxItems: 1024 })), states: Type.Optional(Type.Array(SessionStateUpdate, { maxItems: 16 * SESSION_STATE_LIMIT })),
    removed: Type.Optional(Type.Array(SessionStateRef, { maxItems: 16 * SESSION_STATE_LIMIT })) }),
  // Only on channels that requested reads. A snapshot carries every position of the account; other frames the ones that advanced.
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('session_reads'), snapshot: Type.Optional(Type.Literal(true)), since: Type.Optional(SessionReadsSince),
    reads: Type.Optional(Type.Array(SessionRead, { maxItems: SESSION_READ_LIMIT })) }),
  // Only on channels that requested drafts. A snapshot carries every draft of the account; other frames the ones that changed.
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('session_drafts'), snapshot: Type.Optional(Type.Literal(true)),
    drafts: Type.Array(SessionDraft, { maxItems: SESSION_DRAFT_LIMIT }) }),
  // Only on channels that requested the outbox. A snapshot carries every entry of the account; other frames the ones that
  // changed and the IDs of the ones that left it (delivered or cancelled).
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('session_outbox'), snapshot: Type.Optional(Type.Literal(true)),
    entries: Type.Array(OutboxEntry, { maxItems: OUTBOX_LIMIT }), removed: Type.Optional(Type.Array(OutboxEntry.properties.id, { maxItems: OUTBOX_HOST_LIMIT })) }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('ready'), successions: Type.Optional(Type.Literal(1)), preemption: Type.Optional(Type.Literal(1)) }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('message'), subscriptionId: SubscriptionId, message: Type.Union([ServerMessage, IncompatibleProtocolVersionErrorMessage]) }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('closed'), subscriptionId: SubscriptionId, code: Type.Integer(), reason: Type.String() }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('pong') }),
]);
export type SessionChannelServerMessage = Static<typeof SessionChannelServerMessage>;
