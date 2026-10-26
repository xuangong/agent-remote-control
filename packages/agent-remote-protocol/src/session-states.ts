import { Type, type Static } from '@sinclair/typebox';

/**
 * Session states a Controller reports to its Relay, which shares them with every page of the account without
 * opening session streams. Only identities, the state and the native update time travel; no titles or content.
 * A session without a reported state is unknown.
 */
export const SessionActivityState = Type.Union([Type.Literal('running'), Type.Literal('waiting'), Type.Literal('idle'), Type.Literal('failed')]);
export type SessionActivityState = Static<typeof SessionActivityState>;

/** A Controller confirms every state it knows at least this often. */
export const SESSION_STATE_CONFIRMATION_MS = 60_000;
/** A state not confirmed for this long is no longer trusted and reads as unknown. */
export const SESSION_STATE_STALE_MS = 3 * SESSION_STATE_CONFIRMATION_MS;
/** The most states one Host reports. */
export const SESSION_STATE_LIMIT = 4096;

const object = { additionalProperties: false } as const;
const identity = Type.String({ minLength: 1, maxLength: 512 });
const nativeId = Type.String({ minLength: 1, maxLength: 4096 });
const milliseconds = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const HostSessionState = Type.Object({ providerId: identity, nativeSessionId: nativeId, state: SessionActivityState, updatedAt: Type.Optional(milliseconds) }, object);
export type HostSessionState = Static<typeof HostSessionState>;
export const HostSessionRef = Type.Object({ providerId: identity, nativeSessionId: nativeId }, object);
export type HostSessionRef = Static<typeof HostSessionRef>;

/** A complete report replaces the Host's states and confirms them; otherwise it changes and removes the listed ones. */
export const HostSessionStates = Type.Object({
  full: Type.Boolean(),
  states: Type.Array(HostSessionState, { maxItems: SESSION_STATE_LIMIT }),
  removed: Type.Optional(Type.Array(HostSessionRef, { maxItems: SESSION_STATE_LIMIT })),
}, object);
export type HostSessionStates = Static<typeof HostSessionStates>;

/** ageMs: how long before sending the Relay last had the state confirmed. */
export const SessionStateUpdate = Type.Object({ hostId: identity, ...HostSessionState.properties, ageMs: milliseconds }, object);
export type SessionStateUpdate = Static<typeof SessionStateUpdate>;
export const SessionStateRef = Type.Object({ hostId: identity, ...HostSessionRef.properties }, object);
export type SessionStateRef = Static<typeof SessionStateRef>;
/** confirmedAgeMs: how long before sending the Host last confirmed all its states; absent until it reports any. */
export const SessionStateHost = Type.Object({ hostId: identity, online: Type.Boolean(), confirmedAgeMs: Type.Optional(milliseconds) }, object);
export type SessionStateHost = Static<typeof SessionStateHost>;
