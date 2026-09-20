import { type Static, Type } from '@sinclair/typebox';

import { SafeNonNegativeInteger, SafeTimelinePosition, TimelineHistoryCursor } from './cursor.js';
import { ProjectedTimelineEntry } from './timeline.js';
import { ProtocolVersionSchema } from './version.js';

const NonEmptyString = Type.String({ minLength: 1 });
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(
  properties,
  { additionalProperties: false },
);

export const TimelineDirection = Type.Union([
  Type.Literal('tail'), Type.Literal('before'), Type.Literal('after'),
]);
export type TimelineDirection = Static<typeof TimelineDirection>;

export const TimelineRequest = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('timeline_request'),
  payload: Strict({
    requestId: NonEmptyString,
    agentId: NonEmptyString,
    direction: TimelineDirection,
    cursor: Type.Optional(TimelineHistoryCursor),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  }),
});
export type TimelineRequest = Static<typeof TimelineRequest>;

export const HistoryPage = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('timeline_page'),
  payload: Strict({
    requestId: NonEmptyString,
    agentId: NonEmptyString,
    direction: TimelineDirection,
    epoch: NonEmptyString,
    reset: Type.Boolean(),
    staleCursor: Type.Boolean(),
    gap: Type.Boolean(),
    window: Strict({ minSeq: SafeTimelinePosition, maxSeq: SafeNonNegativeInteger, nextSeq: SafeNonNegativeInteger }),
    startCursor: Type.Union([TimelineHistoryCursor, Type.Null()]),
    endCursor: Type.Union([TimelineHistoryCursor, Type.Null()]),
    hasOlder: Type.Boolean(),
    hasNewer: Type.Boolean(),
    entries: Type.Array(ProjectedTimelineEntry),
    error: Type.Union([Type.String(), Type.Null()]),
  }),
});
export type HistoryPage = Static<typeof HistoryPage>;
