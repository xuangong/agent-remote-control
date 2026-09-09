import { type Static, Type } from '@sinclair/typebox';

export const SafeNonNegativeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const TimelineCursor = Type.Object({
  epoch: Type.String({ minLength: 1 }),
  seq: SafeNonNegativeInteger,
}, { additionalProperties: false });
export type TimelineCursor = Static<typeof TimelineCursor>;
