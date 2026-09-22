import { Type, type Static } from '@sinclair/typebox';
import { PROTOCOL_VERSION } from './version.js';
import { Value } from '@sinclair/typebox/value';
const object = { additionalProperties: false } as const;
export const CONTROLLER_REPOSITORY = 'xuangong/agent-remote-control';
export const ControllerVersion = Type.String({ maxLength: 48, pattern: '^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$' });
export const ControllerIdentity = Type.Object({
  version: ControllerVersion, revision: Type.String({ pattern: '^[a-f0-9]{40}$' }),
  platform: Type.String({ maxLength: 32 }), arch: Type.String({ maxLength: 32 }), nodeMajor: Type.Integer({ minimum: 22, maximum: 100 }),
  remoteUpdate: Type.Boolean(),
}, object);
export type ControllerIdentity = Static<typeof ControllerIdentity>;
export const ControllerRelease = Type.Object({
  protocolVersion: Type.String({ minLength: 1, maxLength: 48 }),
  version: ControllerVersion, revision: Type.String({ pattern: '^[a-f0-9]{40}$' }), sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  asset: Type.String({ maxLength: 150 }), nodeMajor: Type.Integer({ minimum: 22, maximum: 100 }),
  platforms: Type.Array(Type.String({ pattern: '^(darwin|linux|win32)-(arm64|x64)$' }), { minItems: 1, maxItems: 6, uniqueItems: true }),
}, object);
export type ControllerRelease = Static<typeof ControllerRelease>;
export function isControllerRelease(value: unknown): value is ControllerRelease {
  return Value.Check(ControllerRelease, value) && value.asset === `orchardworks-agent-remote-controller-${value.version}.tgz`;
}
export const isControllerIdentity = (value: unknown): value is ControllerIdentity => Value.Check(ControllerIdentity, value);
export const isControllerVersion = (value: unknown): value is string => Value.Check(ControllerVersion, value);
export function compareControllerVersions(a: string, b: string): number {
  if (!isControllerVersion(a) || !isControllerVersion(b)) throw new Error('Invalid Controller version.');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  return 0;
}
export function releaseCoversHost(release: ControllerRelease, host: Pick<ControllerIdentity, 'platform' | 'arch' | 'nodeMajor'>): boolean {
  return release.protocolVersion === PROTOCOL_VERSION && host.nodeMajor >= release.nodeMajor && release.platforms.includes(`${host.platform}-${host.arch}`);
}
export type ControllerUpdatePhase = 'idle' | 'downloading' | 'waiting' | 'restarting' | 'succeeded' | 'failed';
export interface ControllerUpdateStatus { phase: ControllerUpdatePhase; version?: string; operationId?: string; message?: string; updatedAt: number }
