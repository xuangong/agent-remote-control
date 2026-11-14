import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * The outbox: messages the owner sent to a session whose Host was offline. Each waits on the Relay, visible and
 * cancellable on every device, until the Host's Controller takes it (claim), sends it to the session and reports the
 * outcome (settle). It is not part of the conversation until the session accepts it; accepted messages leave the outbox.
 * Text only: images and files need the Host to upload to.
 */
/** The most UTF-8 bytes a waiting message may take. */
export const OUTBOX_TEXT_BYTES = 16384;
/** The most messages an account's outbox holds. */
export const OUTBOX_LIMIT = 32;
/** The most messages waiting for one Host across accounts, which bounds a poll. */
export const OUTBOX_HOST_LIMIT = 512;

const object = { additionalProperties: false } as const;
const identity = Type.String({ minLength: 1, maxLength: 512 });
const nativeId = Type.String({ minLength: 1, maxLength: 4096 });
const id = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const text = Type.String({ minLength: 1, maxLength: OUTBOX_TEXT_BYTES });
const milliseconds = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const reason = Type.String({ minLength: 1, maxLength: 512 });
const encoder = new (globalThis as unknown as { TextEncoder: new () => { encode(value: string): Uint8Array } }).TextEncoder();
const fits = (value: { text: string }) => encoder.encode(value.text).length <= OUTBOX_TEXT_BYTES;

/** waiting: for its Host; delivering: its Controller claimed it; failed: the session refused it; unknown: a claim lost its outcome. */
export const OutboxStatus = Type.Union([Type.Literal('waiting'), Type.Literal('delivering'), Type.Literal('failed'), Type.Literal('unknown')]);
export type OutboxStatus = Static<typeof OutboxStatus>;
export const OutboxRequest = Type.Object({ id, hostId: identity, providerId: identity, nativeSessionId: nativeId, text }, object);
export type OutboxRequest = Static<typeof OutboxRequest>;
export const OutboxEntry = Type.Object({ id, hostId: identity, providerId: identity, nativeSessionId: nativeId, text, createdAt: milliseconds, status: OutboxStatus, error: Type.Optional(reason) }, object);
export type OutboxEntry = Static<typeof OutboxEntry>;
export const OutboxEntries = Type.Object({ entries: Type.Array(OutboxEntry, { maxItems: OUTBOX_LIMIT }) }, object);
export type OutboxEntries = Static<typeof OutboxEntries>;

/** What a Controller sees of a message for its Host. */
export const OutboxDelivery = Type.Object({ id, providerId: identity, nativeSessionId: nativeId, text, createdAt: milliseconds,
  status: Type.Union([Type.Literal('waiting'), Type.Literal('delivering')]) }, object);
export type OutboxDelivery = Static<typeof OutboxDelivery>;
export const OutboxPoll = Type.Object({ entries: Type.Array(OutboxDelivery, { maxItems: OUTBOX_HOST_LIMIT }) }, object);
export type OutboxPoll = Static<typeof OutboxPoll>;
export const OutboxHostCall = Type.Union([
  Type.Object({ action: Type.Literal('poll') }, object),
  Type.Object({ action: Type.Literal('claim'), id }, object),
  Type.Object({ action: Type.Literal('settle'), id, outcome: Type.Union([Type.Literal('accepted'), Type.Literal('rejected'), Type.Literal('unknown')]), error: Type.Optional(reason) }, object),
]);
export type OutboxHostCall = Static<typeof OutboxHostCall>;

export const isOutboxRequest = (value: unknown): value is OutboxRequest => Value.Check(OutboxRequest, value) && fits(value);
export const isOutboxEntry = (value: unknown): value is OutboxEntry => Value.Check(OutboxEntry, value) && fits(value);
export const isOutboxEntries = (value: unknown): value is OutboxEntries => Value.Check(OutboxEntries, value) && value.entries.every(fits);
export const isOutboxPoll = (value: unknown): value is OutboxPoll => Value.Check(OutboxPoll, value) && value.entries.every(fits);
export const isOutboxHostCall = (value: unknown): value is OutboxHostCall => Value.Check(OutboxHostCall, value);
