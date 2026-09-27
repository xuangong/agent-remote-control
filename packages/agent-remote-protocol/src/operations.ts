import { type Static, Type } from '@sinclair/typebox';

export const OperationId = Type.String({
  minLength: 36,
  maxLength: 36,
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
});
export type OperationId = Static<typeof OperationId>;

/** Acceptance describes the submitted input, not execution completion or session idleness. */
export const AgentInputAcceptance = Type.Object({
  disposition: Type.Union([Type.Literal('started'), Type.Literal('queued'), Type.Literal('handled')]),
}, { additionalProperties: false });
export type AgentInputAcceptance = Static<typeof AgentInputAcceptance>;
