import { type Static, Type } from '@sinclair/typebox';

const NonEmptyString = Type.String({ minLength: 1 });
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });

export const AgentSessionSettingOption = Strict({
  value: NonEmptyString,
  label: NonEmptyString,
  description: Type.Optional(Type.String()),
});
export type AgentSessionSettingOption = Static<typeof AgentSessionSettingOption>;

export const AgentSessionSetting = Strict({
  id: NonEmptyString,
  category: Type.Union([Type.Literal('model'), Type.Literal('permissions')]),
  label: NonEmptyString,
  value: Type.Union([NonEmptyString, Type.Null()]),
  options: Type.Array(AgentSessionSettingOption),
  mutable: Type.Boolean(),
  scope: Type.Union([Type.Literal('session'), Type.Literal('session_and_default')]),
  description: Type.Optional(Type.String()),
});
export type AgentSessionSetting = Static<typeof AgentSessionSetting>;

/** Accepted intent, independent of the Provider's confirmed runtime settings. */
export const AgentSessionSettingChange = Strict({
  category: Type.Union([Type.Literal('model'), Type.Literal('permissions')]),
  label: NonEmptyString,
  settingId: NonEmptyString,
  requestId: NonEmptyString,
  targetValue: NonEmptyString,
  confirmedValue: Type.Union([NonEmptyString, Type.Null()]),
  status: Type.Union([Type.Literal('pending'), Type.Literal('failed'), Type.Literal('timed_out')]),
  requestedAt: NonEmptyString,
  deadlineAt: NonEmptyString,
  message: Type.Optional(NonEmptyString),
  code: Type.Optional(NonEmptyString),
});
export type AgentSessionSettingChange = Static<typeof AgentSessionSettingChange>;
