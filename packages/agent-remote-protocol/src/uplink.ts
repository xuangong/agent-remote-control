import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { WireDecodeResult, WireEncodeResult } from './codec.js';

export const UPLINK_VERSION = 1;
export const UPLINK_MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const UPLINK_MAX_PUBLIC_REQUEST_BYTES = 1024 * 1024;

const identity = Type.String({ minLength: 1, maxLength: 512 });
const version = Type.Literal(UPLINK_VERSION);
const stream = { uplinkVersion: version, streamId: identity };
const rpc = { uplinkVersion: version, requestId: identity };
const object = { additionalProperties: false } as const;
const closeCode = Type.Union([
  ...[1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].map((code) => Type.Literal(code)),
  Type.Integer({ minimum: 3000, maximum: 4999 }),
]);

export const UplinkMessage = Type.Union([
  Type.Object({ uplinkVersion: version, type: Type.Literal('register'), agentId: identity }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('registered'), agentId: identity }, object),
  Type.Object({ ...rpc, type: Type.Literal('rpc_request'),
    method: Type.Union([Type.Literal('GET'), Type.Literal('POST')]),
    path: Type.String({ maxLength: 8192, pattern: '^/v1/(providers|sessions)([/?][^#]*)?$' }),
    body: Type.Optional(Type.String()),
  }, object),
  Type.Object({ ...rpc, type: Type.Literal('rpc_response'),
    status: Type.Integer({ minimum: 200, maximum: 599 }), body: Type.String(),
  }, object),
  Type.Object({ ...rpc, type: Type.Literal('rpc_cancel') }, object),
  Type.Object({ ...stream, type: Type.Literal('stream_open') }, object),
  Type.Object({ ...stream, type: Type.Literal('stream_opened') }, object),
  Type.Object({ ...stream, type: Type.Literal('stream_message'), message: Type.String() }, object),
  Type.Object({ ...stream, type: Type.Literal('stream_close'),
    code: closeCode, reason: Type.String({ maxLength: 123 }),
  }, object),
]);
export type UplinkMessage = Static<typeof UplinkMessage>;
export type UplinkBrokerMessage = Extract<UplinkMessage,
  { type: 'registered' | 'rpc_request' | 'rpc_cancel' | 'stream_open' | 'stream_message' | 'stream_close' }>;

export function decodeUplinkMessage(json: string): WireDecodeResult<UplinkMessage> {
  let value: unknown;
  try { value = JSON.parse(json); } catch {
    return { status: 'rejected', issues: [{ code: 'invalid_json', path: '', message: 'Invalid uplink JSON.' }] };
  }
  if (!validMessage(value)) {
    return { status: 'rejected', issues: [{ code: 'invalid_shape', path: '', message: 'Invalid uplink envelope.' }] };
  }
  return { status: 'ok', value };
}

export function encodeUplinkMessage(value: UplinkMessage): WireEncodeResult {
  if (!validMessage(value)) {
    return { status: 'rejected', issues: [{ code: 'invalid_shape', path: '', message: 'Invalid uplink envelope.' }] };
  }
  return { status: 'ok', json: JSON.stringify(value) };
}

function validMessage(value: unknown): value is UplinkMessage {
  if (!Value.Check(UplinkMessage, value)) return false;
  if (value.type !== 'stream_close') return true;
  let bytes = 0;
  for (const character of value.reason) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes <= 123;
}
