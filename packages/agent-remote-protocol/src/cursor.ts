import { type Static, Type } from '@sinclair/typebox';

export const SafeNonNegativeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const TimelineCursor = Type.Object({
  epoch: Type.String({ minLength: 1 }),
  seq: SafeNonNegativeInteger,
}, { additionalProperties: false });
export type TimelineCursor = Static<typeof TimelineCursor>;

/** Stable positions preceding the initially loaded Timeline; live cursors remain nonnegative. */
export const SafeTimelinePosition = Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
export const TimelineHistoryCursor = Type.Object({ epoch: Type.String({ minLength: 1 }), seq: SafeTimelinePosition }, { additionalProperties: false });
export type TimelineHistoryCursor = Static<typeof TimelineHistoryCursor>;
