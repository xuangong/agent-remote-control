import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const VscodeTunnelSnapshotSchema = Type.Object({
  status: Type.Union((['checking', 'unavailable', 'stopped', 'starting', 'awaiting_auth', 'connecting', 'connected', 'stopping', 'exited', 'failed'] as const).map(value => Type.Literal(value))),
  processAlive: Type.Boolean(),
  revision: Type.Integer({ minimum: 0 }),
  pid: Type.Optional(Type.Integer()),
  tunnelName: Type.Optional(Type.String()),
  link: Type.Optional(Type.String()),
  attached: Type.Optional(Type.Boolean()),
  authorization: Type.Optional(Type.Object({ url: Type.String(), code: Type.String() })),
  exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  signal: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type VscodeTunnelSnapshot = Static<typeof VscodeTunnelSnapshotSchema>;

export function parseVscodeTunnelSnapshot(value: unknown): VscodeTunnelSnapshot {
  if (!Value.Check(VscodeTunnelSnapshotSchema, value)) throw new Error('Invalid VS Code tunnel status. Update the Controller.');
  return value;
}

export function vscodeTunnelLink(name: string): string | undefined {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,59}$/.test(name) ? `https://vscode.dev/tunnel/${name}` : undefined;
}

export function vscodeWorkspaceLink(name: string, workspace: string): string | undefined {
  const base = vscodeTunnelLink(name);
  const path = workspace.replace(/\\/g, '/');
  if (!base || (!path.startsWith('/') && !/^[a-zA-Z]:\//.test(path)) || /[\u0000-\u001f]/.test(path)) return undefined;
  const segments = path.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..')) return undefined;
  return `${base}/${segments.map(encodeURIComponent).join('/')}`;
}
