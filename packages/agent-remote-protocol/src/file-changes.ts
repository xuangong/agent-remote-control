import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const strict = { additionalProperties: false } as const;
export const AgentFileChange = Type.Object({
  path: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal('added'), Type.Literal('modified'), Type.Literal('deleted'), Type.Literal('renamed'), Type.Literal('unknown')]),
  previousPath: Type.Optional(Type.String({ minLength: 1 })),
  diff: Type.String(),
}, strict);
export type AgentFileChange = Static<typeof AgentFileChange>;

export const AgentFileChangesResult = Type.Object({
  format: Type.Literal('file_changes'), version: Type.Literal(1), files: Type.Array(AgentFileChange),
}, strict);
export type AgentFileChangesResult = Static<typeof AgentFileChangesResult>;

export function isAgentFileChangesResult(value: unknown): value is AgentFileChangesResult {
  return Value.Check(AgentFileChangesResult, value);
}
