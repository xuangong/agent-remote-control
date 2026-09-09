import { type Static, Type } from '@sinclair/typebox';

const strict = { additionalProperties: false } as const;
export const AgentToolResultJson = Type.Recursive((value) => Type.Union([
  Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(value), Type.Record(Type.String(), value),
]));
export type AgentToolResultJson = Static<typeof AgentToolResultJson>;
export const AgentToolResultContent = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Type.String(), stream: Type.Optional(Type.Union([
    Type.Literal('stdout'), Type.Literal('stderr'), Type.Literal('combined'),
  ])) }, strict),
  Type.Object({ type: Type.Literal('json'), value: AgentToolResultJson }, strict),
]);
export type AgentToolResultContent = Static<typeof AgentToolResultContent>;
export const AgentToolResult = Type.Object({
  content: Type.Array(AgentToolResultContent),
  exitCode: Type.Optional(Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER })),
  durationMs: Type.Optional(Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  truncated: Type.Optional(Type.Boolean()),
}, strict);
export type AgentToolResult = Static<typeof AgentToolResult>;
