import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
const object = { additionalProperties: false } as const;
const providerId = Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9-]*$' });
export const HostProviderState = Type.Object({
  providerId, displayName: Type.String({ minLength: 1, maxLength: 128 }),
  state: Type.Union([Type.Literal('enabled'), Type.Literal('disabled'), Type.Literal('unavailable')]),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
}, object);
export type HostProviderState = Static<typeof HostProviderState>;
export const HostProviderSettings = Type.Object({ revision: Type.String({ minLength: 1, maxLength: 128 }), providers: Type.Array(HostProviderState, { maxItems: 64 }) }, object);
export type HostProviderSettings = Static<typeof HostProviderSettings>;
export const HostProviderChange = Type.Union([
  Type.Object({ refresh: Type.Literal(true) }, object),
  Type.Object({ providerId, enabled: Type.Boolean(), revision: Type.String({ minLength: 1, maxLength: 128 }) }, object),
]);
export type HostProviderChange = Static<typeof HostProviderChange>;
export const isHostProviderSettings = (value: unknown): value is HostProviderSettings => Value.Check(HostProviderSettings, value)
  && new Set(value.providers.map(item => item.providerId)).size === value.providers.length;
export const isHostProviderChange = (value: unknown): value is HostProviderChange => Value.Check(HostProviderChange, value);
