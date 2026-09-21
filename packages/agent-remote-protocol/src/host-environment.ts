import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const object = { additionalProperties: false } as const;
const label = Type.String({ minLength: 1, maxLength: 160, pattern: '^[^\\x00-\\x1f\\x7f]+$' });
export const HostDetectionStatus = Type.Union([Type.Literal('found'), Type.Literal('not-found'), Type.Literal('unknown')]);
const tool = Type.Object({ id: label, name: label, status: HostDetectionStatus }, object);
/** Describes the Controller execution environment, not permissions or remote-control capabilities. */
export const HostEnvironment = Type.Object({
  detectedAt: Type.Integer({ minimum: 0 }),
  os: Type.Object({ platform: label, name: label, arch: label, release: label }, object),
  wsl: Type.Union([Type.Boolean(), Type.Null()]),
  container: Type.Union([Type.Boolean(), Type.Null()]),
  shell: Type.Object({ name: Type.Optional(label), source: Type.Union([Type.Literal('account'), Type.Literal('environment'), Type.Literal('unknown')]) }, object),
  shells: Type.Array(tool, { maxItems: 16 }),
  browsers: Type.Array(tool, { maxItems: 16 }),
  vscode: Type.Object({ status: HostDetectionStatus }, object),
}, object);
export type HostEnvironment = Static<typeof HostEnvironment>;
export type HostDetectionStatus = Static<typeof HostDetectionStatus>;
export function isHostEnvironment(value: unknown): value is HostEnvironment { return Value.Check(HostEnvironment, value); }
