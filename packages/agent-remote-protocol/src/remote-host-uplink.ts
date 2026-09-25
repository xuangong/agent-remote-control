import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { PairingPurpose } from './pairing.js';
import { ControllerIdentity } from './controller-release.js';
import { HostEnvironment } from './host-environment.js';

import type { WireDecodeResult, WireEncodeResult } from './codec.js';

export const REMOTE_HOST_UPLINK_VERSION = 2;

const identity = Type.String({ minLength: 1, maxLength: 512 });
const version = Type.Literal(REMOTE_HOST_UPLINK_VERSION);
const object = { additionalProperties: false } as const;
const heartbeatDuration = Type.Integer({ minimum: 1, maximum: 600000 });
export const RemoteHostHeartbeat = Type.Object({ intervalMs: heartbeatDuration, timeoutMs: heartbeatDuration }, object);
export type RemoteHostHeartbeat = Static<typeof RemoteHostHeartbeat>;
const heartbeatNonce = Type.String({ minLength: 1, maxLength: 128 });
const rpc = { uplinkVersion: version, requestId: identity };
const stream = { uplinkVersion: version, streamId: identity };
const provider = Type.Object({ providerId: identity, displayName: identity, promptEditing: Type.Optional(Type.Literal(true)), sessionRename: Type.Optional(Type.Literal(true)), daemonControl: Type.Optional(Type.Literal(true)) }, object);
export const PreviewRegistrationSnapshot = Type.Object({
  epoch: identity, revision: Type.Integer({ minimum: 0 }),
  registrations: Type.Array(Type.Object({
    id: identity, target: Type.String({ maxLength: 2048 }),
    status: Type.Union([Type.Literal('active'), Type.Literal('expired'), Type.Literal('unregistered')]),
    createdAt: Type.Number(), expiresAt: Type.Number(), revision: Type.Integer({ minimum: 0 }),
    pathMode: Type.Union([Type.Literal('strip'), Type.Literal('preserve')]),
    sources: Type.Array(Type.Object({ sessionId: identity, itemId: identity }, object), { maxItems: 256 }),
  }, object), { maxItems: 1024 }),
}, object);
export type PreviewRegistrationSnapshot = Static<typeof PreviewRegistrationSnapshot>;
const closeCode = Type.Union([
  ...[1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].map((code) => Type.Literal(code)),
  Type.Integer({ minimum: 3000, maximum: 4999 }),
]);

const requestPath = Type.String({
  maxLength: 8192,
  pattern: '^/(remote/(catalog(?:/(?:revision|session))?|workspaces|workspace-folders(?:/create)?(?=\\?|$)|models|diagnostics/relay(?=$)|controller-update(?=$)|codex-daemon(?=$)|provider-settings(?=$)|session/rename(?=$)|child/attach|attach|create|stop|vscode-tunnel(?:/(?:start|stop))?(?=$)|previews(?:/unregister)?)|v1/(providers|sessions))(?:[/?][^#]*)?$',
});

export const RemoteHostUplinkMessage = Type.Union([
  Type.Union([
    Type.Object({ uplinkVersion: version, type: Type.Literal('register'), installationId: identity, name: identity, environment: Type.Optional(HostEnvironment), controller: Type.Optional(ControllerIdentity), providerManagement: Type.Optional(Type.Literal(true)), credentialRotation: Type.Optional(Type.Literal(true)),
      providerId: Type.Literal('dsh') }, object),
    Type.Object({ uplinkVersion: version, type: Type.Literal('register'), installationId: identity, name: identity, environment: Type.Optional(HostEnvironment), controller: Type.Optional(ControllerIdentity), providerManagement: Type.Optional(Type.Literal(true)), credentialRotation: Type.Optional(Type.Literal(true)),
      providers: Type.Array(provider, { minItems: 0, maxItems: 64 }) }, object),
  ]),
  Type.Object({ uplinkVersion: version, type: Type.Literal('credential_issued'), credential: Type.String({ minLength: 1, maxLength: 512, pattern: '^[!-~]+$' }) }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('credential_saved') }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('registered'), hostId: identity, pairingPurpose: Type.Optional(PairingPurpose), heartbeat: RemoteHostHeartbeat, tunnelToken: Type.Optional(identity) }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('provider_snapshot'), providers: Type.Array(provider, { maxItems: 64 }) }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('preview_snapshot'), snapshot: PreviewRegistrationSnapshot }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('heartbeat'), nonce: heartbeatNonce }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('heartbeat_ack'), nonce: heartbeatNonce }, object),
  Type.Object({ ...rpc, type: Type.Literal('rpc_request'), method: Type.Union([Type.Literal('GET'), Type.Literal('POST')]),
    path: requestPath, sessionId: Type.Optional(identity), body: Type.Optional(Type.String()) }, object),
  Type.Object({ ...rpc, type: Type.Literal('rpc_response'), status: Type.Integer({ minimum: 200, maximum: 599 }),
    body: Type.String() }, object),
  Type.Object({ ...rpc, type: Type.Literal('rpc_cancel') }, object),
  Type.Object({ ...stream, type: Type.Literal('stream_open'), sessionId: identity }, object),
  Type.Object({ ...stream, type: Type.Literal('stream_opened') }, object),
  Type.Object({ ...stream, type: Type.Literal('stream_message'), message: Type.String() }, object),
  Type.Object({ ...stream, type: Type.Literal('stream_close'), code: closeCode, reason: Type.String({ maxLength: 123 }) }, object),
]);

export type RemoteHostUplinkMessage = Static<typeof RemoteHostUplinkMessage>;
export type RemoteHostUplinkBrokerMessage = Extract<RemoteHostUplinkMessage,
  { type: 'credential_issued' | 'registered' | 'heartbeat' | 'rpc_request' | 'rpc_cancel' | 'stream_open' | 'stream_message' | 'stream_close' }>;

export function decodeRemoteHostUplinkMessage(json: string): WireDecodeResult<RemoteHostUplinkMessage> {
  let value: unknown;
  try { value = JSON.parse(json); } catch {
    return { status: 'rejected', issues: [{ code: 'invalid_json', path: '', message: 'Invalid Remote Host uplink JSON.' }] };
  }
  if (!validRemoteHostUplinkMessage(value)) {
    return { status: 'rejected', issues: [{ code: 'invalid_shape', path: '', message: 'Invalid Remote Host uplink envelope.' }] };
  }
  return { status: 'ok', value };
}

export function encodeRemoteHostUplinkMessage(value: RemoteHostUplinkMessage): WireEncodeResult {
  if (!validRemoteHostUplinkMessage(value)) {
    return { status: 'rejected', issues: [{ code: 'invalid_shape', path: '', message: 'Invalid Remote Host uplink envelope.' }] };
  }
  return { status: 'ok', json: JSON.stringify(value) };
}

function validRemoteHostUplinkMessage(value: unknown): value is RemoteHostUplinkMessage {
  if (!Value.Check(RemoteHostUplinkMessage, value)) return false;
  if (value.type === 'registered' && value.heartbeat.timeoutMs >= value.heartbeat.intervalMs) return false;
  if ((value.type === 'register' || value.type === 'provider_snapshot') && 'providers' in value
    && new Set(value.providers.map((provider) => provider.providerId)).size !== value.providers.length) return false;
  if (value.type === 'rpc_request') {
    const pathname = value.path.split('?', 1)[0]!;
    const sessionScoped = pathname === '/remote/attach' || pathname === '/remote/child/attach' || pathname === '/remote/create' || pathname === '/v1/providers'
      || /^\/v1\/sessions\/[^/]+\/(snapshot|timeline)$/.test(pathname);
    if (sessionScoped !== (value.sessionId !== undefined)) return false;
    if (pathname === '/remote/previews' || pathname === '/remote/controller-update' || pathname === '/remote/codex-daemon' || pathname === '/remote/provider-settings') return value.method === 'GET' ? value.body === undefined : value.body !== undefined;
    if (pathname.startsWith('/remote/')) {
      const isRead = pathname === '/remote/catalog' || pathname === '/remote/catalog/revision'
        || pathname === '/remote/catalog/session' || pathname === '/remote/workspaces' || pathname === '/remote/workspace-folders' || pathname === '/remote/models' || pathname === '/remote/vscode-tunnel';
      if ((isRead && (value.method !== 'GET' || value.body !== undefined))
        || (!isRead && (value.method !== 'POST' || value.body === undefined))) return false;
    }
  }
  if (value.type !== 'stream_close') return true;
  let bytes = 0;
  for (const character of value.reason) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes <= 123;
}
