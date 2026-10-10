import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { CommittedSuccessionProjection, isCommittedSuccessionProjection, isPrimaryRole, PrimaryRole } from './session-succession.js';
const strict = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 512, pattern: '^[^\\u0000-\\u001f]+$' });
export const SuccessionSessionLocator = Type.Object({ hostId: id, providerId: id, nativeSessionId: id }, strict);
export type SuccessionSessionLocator = Static<typeof SuccessionSessionLocator>;
/** Locators are authorized transport addresses; the projection remains immutable native evidence. */
export const SessionSuccessionReplay = Type.Object({ version: Type.Literal(1), projection: CommittedSuccessionProjection,
  from: SuccessionSessionLocator, to: SuccessionSessionLocator }, strict);
export type SessionSuccessionReplay = Static<typeof SessionSuccessionReplay>;
export const SessionSuccessionReplayPage = Type.Object({ version: Type.Literal(1),
  successions: Type.Array(SessionSuccessionReplay, { maxItems: 64 }), nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]) }, strict);
export type SessionSuccessionReplayPage = Static<typeof SessionSuccessionReplayPage>;
export const SessionSuccessionCurrent = Type.Object({ version: Type.Literal(1), role: PrimaryRole, locator: SuccessionSessionLocator }, strict);
export type SessionSuccessionCurrent = Static<typeof SessionSuccessionCurrent>;
export const isSessionSuccessionReplay = (value: unknown): value is SessionSuccessionReplay => {
  if (!Value.Check(SessionSuccessionReplay, value)) return false;
  const item = value as SessionSuccessionReplay;
  return isCommittedSuccessionProjection(item.projection)
    && item.from.providerId === item.projection.receipt.from.providerId && item.from.nativeSessionId === item.projection.receipt.from.nativeSessionId
    && item.to.providerId === item.projection.role.current.providerId && item.to.nativeSessionId === item.projection.role.current.nativeSessionId
    && item.from.hostId === item.to.hostId;
};
export const isSessionSuccessionReplayPage = (value: unknown): value is SessionSuccessionReplayPage =>
  Value.Check(SessionSuccessionReplayPage, value) && (value as SessionSuccessionReplayPage).successions.every(isSessionSuccessionReplay);
export const isSessionSuccessionCurrent = (value: unknown): value is SessionSuccessionCurrent => {
  if (!Value.Check(SessionSuccessionCurrent, value)) return false;
  const item = value as SessionSuccessionCurrent;
  return isPrimaryRole(item.role) && item.locator.providerId === item.role.current.providerId && item.locator.nativeSessionId === item.role.current.nativeSessionId;
};
