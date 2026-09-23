import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const uuid = Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' });
export const CodexDaemonRestart = Type.Object({ operationId: uuid, revision: uuid }, { additionalProperties: false });
export type CodexDaemonRestart = Static<typeof CodexDaemonRestart>;
export const CodexDaemonStatus = Type.Object({
  revision: uuid, operationId: Type.Optional(uuid),
  phase: Type.Union((['idle', 'restarting', 'ready', 'failed', 'unknown'] as const).map(value => Type.Literal(value))),
  updatedAt: Type.Number(), message: Type.Optional(Type.String({ maxLength: 1024 })),
}, { additionalProperties: false });
export type CodexDaemonStatus = Static<typeof CodexDaemonStatus>;
export const isCodexDaemonRestart = (value: unknown): value is CodexDaemonRestart => Value.Check(CodexDaemonRestart, value);
export const isCodexDaemonStatus = (value: unknown): value is CodexDaemonStatus => Value.Check(CodexDaemonStatus, value);
