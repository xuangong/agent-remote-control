import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Read positions: per account and session, the time of the latest reply the owner has seen, shared by every device.
 * A reply is unread when it came after the session's position, or, for a session without one, after the account
 * started keeping positions (`since`), so replies from before then never show as unread.
 */
/** The most positions an account keeps; the oldest go first. */
export const SESSION_READ_LIMIT = 1024;
/** The most positions one request may advance. */
export const SESSION_READ_BATCH = 256;

const object = { additionalProperties: false } as const;
const identity = Type.String({ minLength: 1, maxLength: 512 });
const nativeId = Type.String({ minLength: 1, maxLength: 4096 });
const milliseconds = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const SessionRead = Type.Object({ hostId: identity, providerId: identity, nativeSessionId: nativeId, readAt: milliseconds }, object);
export type SessionRead = Static<typeof SessionRead>;
/** Advances positions; one never moves back. The account's first request also starts its `since`. */
export const SessionReadsRequest = Type.Object({ reads: Type.Array(SessionRead, { maxItems: SESSION_READ_BATCH }) }, object);
export type SessionReadsRequest = Static<typeof SessionReadsRequest>;
export const SessionReads = Type.Object({ since: Type.Optional(milliseconds), reads: Type.Array(SessionRead, { maxItems: SESSION_READ_LIMIT }) }, object);
export type SessionReads = Static<typeof SessionReads>;
export const SessionReadsSince = milliseconds;

export const isSessionRead = (value: unknown): value is SessionRead => Value.Check(SessionRead, value);
export const isSessionReadsRequest = (value: unknown): value is SessionReadsRequest => Value.Check(SessionReadsRequest, value);
export const isSessionReads = (value: unknown): value is SessionReads => Value.Check(SessionReads, value);
