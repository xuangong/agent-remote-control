import { type Static, Type } from '@sinclair/typebox';

import { SafeNonNegativeInteger } from './cursor.js';
import { AgentInteractionRequest, AgentInteractionResponse, AgentToolDetail } from './interactions.js';
import { ResourceBinding } from './resources.js';

const NonEmptyString = Type.String({ minLength: 1 });
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(
  properties,
  { additionalProperties: false },
);

export const AgentTaskItem = Strict({
  text: Type.String(),
  completed: Type.Boolean(),
  id: Type.Optional(NonEmptyString),
  status: Type.Optional(Type.Union([
    Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed'),
  ])),
  activeForm: Type.Optional(Type.String()),
});
export type AgentTaskItem = Static<typeof AgentTaskItem>;

const ToolCallBase = {
  type: Type.Literal('tool_call'),
  callId: NonEmptyString,
  name: NonEmptyString,
  detail: AgentToolDetail,
};

export const AgentToolCallTimelineItem = Type.Union([
  Strict({ ...ToolCallBase, status: Type.Literal('running'), error: Type.Null() }),
  Strict({ ...ToolCallBase, status: Type.Literal('completed'), error: Type.Null() }),
  Strict({ ...ToolCallBase, status: Type.Literal('failed'), error: NonEmptyString }),
  Strict({ ...ToolCallBase, status: Type.Literal('canceled'), error: Type.Null() }),
]);
export type AgentToolCallTimelineItem = Static<typeof AgentToolCallTimelineItem>;

export const AgentTimelineItem = Type.Union([
  Strict({
    type: Type.Literal('user_message'),
    text: Type.String(),
    messageId: Type.Optional(NonEmptyString),
    clientMessageId: Type.Optional(NonEmptyString),
  }),
  Strict({
    type: Type.Literal('assistant_message'),
    text: Type.String(),
    messageId: Type.Optional(NonEmptyString),
  }),
  Strict({ type: Type.Literal('reasoning'), text: Type.String() }),
  AgentToolCallTimelineItem,
  Strict({ type: Type.Literal('todo'), items: Type.Array(AgentTaskItem) }),
  Strict({ type: Type.Literal('interaction'), request: AgentInteractionRequest, response: AgentInteractionResponse }),
  Strict({ type: Type.Literal('error'), message: Type.String() }),
  Strict({
    type: Type.Literal('compaction'),
    status: Type.Union([Type.Literal('loading'), Type.Literal('completed')]),
    trigger: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('manual')])),
    preTokens: Type.Optional(SafeNonNegativeInteger),
  }),
]);
export type AgentTimelineItem = Static<typeof AgentTimelineItem>;

export const AgentUsage = Strict({
  inputTokens: Type.Optional(SafeNonNegativeInteger),
  cachedInputTokens: Type.Optional(SafeNonNegativeInteger),
  outputTokens: Type.Optional(SafeNonNegativeInteger),
  totalCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
  contextWindowMaxTokens: Type.Optional(SafeNonNegativeInteger),
  contextWindowUsedTokens: Type.Optional(SafeNonNegativeInteger),
});
export type AgentUsage = Static<typeof AgentUsage>;

export const TimelineSeqRange = Strict({
  startSeq: SafeNonNegativeInteger,
  endSeq: SafeNonNegativeInteger,
});
export type TimelineSeqRange = Static<typeof TimelineSeqRange>;

export const TimelineCollapse = Type.Union([
  Type.Literal('assistant_merge'),
  Type.Literal('reasoning_merge'),
  Type.Literal('tool_lifecycle'),
]);
export type TimelineCollapse = Static<typeof TimelineCollapse>;

export const ProjectedTimelineEntry = Strict({
  providerId: NonEmptyString,
  item: AgentTimelineItem,
  turnId: Type.Optional(NonEmptyString),
  timestamp: NonEmptyString,
  seqStart: SafeNonNegativeInteger,
  seqEnd: SafeNonNegativeInteger,
  sourceSeqRanges: Type.Array(TimelineSeqRange),
  collapsed: Type.Array(TimelineCollapse),
  resources: Type.Array(ResourceBinding),
});
export type ProjectedTimelineEntry = Static<typeof ProjectedTimelineEntry>;
