import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/** Status of an explicitly requested native session listing. Reading status never starts a listing. */
export const SessionListingStatus = Type.Object({
  refreshing: Type.Boolean(),
  listedAt: Type.Optional(Type.String()),
  complete: Type.Boolean(),
  error: Type.Optional(Type.String({ maxLength: 300 })),
  version: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type SessionListingStatus = Static<typeof SessionListingStatus>;
export const isSessionListingStatus = (value: unknown): value is SessionListingStatus => Value.Check(SessionListingStatus, value);
