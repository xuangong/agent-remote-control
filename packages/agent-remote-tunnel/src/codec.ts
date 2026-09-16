import type { HeaderList, TunnelData } from './types.js';

export type TunnelControlFrame =
  | { type: 'http_open'; streamId: string; previewId: string; method: string; path: string; headers: HeaderList; hasBody: boolean }
  | { type: 'http_response'; streamId: string; status: number; headers: HeaderList; hasBody: boolean }
  | { type: 'body_end'; streamId: string; direction: 'request' | 'response' }
  | { type: 'credit'; streamId: string; direction: 'request' | 'response' | 'ws'; bytes: number }
  | { type: 'cancel'; streamId: string; code: string; message: string }
  | { type: 'ws_open'; streamId: string; previewId: string; path: string; headers: HeaderList; protocols: string[] }
  | { type: 'ws_accept'; streamId: string; protocol?: string }
  | { type: 'ws_close'; streamId: string; code: number; reason: string }
  | { type: 'ping'; nonce: string }
  | { type: 'pong'; nonce: string };

export type TunnelBinaryFrame = { type: 'body_chunk'; streamId: string; direction: 'request' | 'response'; data: Uint8Array }
  | { type: 'ws_message'; streamId: string; binary: boolean; data: Uint8Array };
export type TunnelFrame = TunnelControlFrame | TunnelBinaryFrame;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function encodeTunnelFrame(frame: TunnelFrame, maxFrameBytes = 256 * 1024): TunnelData {
  if (frame.type !== 'body_chunk' && frame.type !== 'ws_message') {
    const value = JSON.stringify(frame);
    if (encoder.encode(value).byteLength > maxFrameBytes) throw new Error('Tunnel frame exceeds the configured maximum.');
    return value;
  }
  const metadata = encoder.encode(JSON.stringify(frame.type === 'body_chunk'
    ? { type: frame.type, streamId: frame.streamId, direction: frame.direction }
    : { type: frame.type, streamId: frame.streamId, binary: frame.binary }));
  const result = new Uint8Array(4 + metadata.byteLength + frame.data.byteLength);
  new DataView(result.buffer).setUint32(0, metadata.byteLength);
  result.set(metadata, 4);
  result.set(frame.data, 4 + metadata.byteLength);
  if (result.byteLength > maxFrameBytes) throw new Error('Tunnel frame exceeds the configured maximum.');
  return result;
}

export function decodeTunnelFrame(data: TunnelData, maxFrameBytes = 256 * 1024): TunnelFrame {
  const size = typeof data === 'string' ? encoder.encode(data).byteLength : data.byteLength;
  if (size > maxFrameBytes) throw new Error('Tunnel frame exceeds the configured maximum.');
  if (typeof data === 'string') return JSON.parse(data) as TunnelControlFrame;
  if (data.byteLength < 4) throw new Error('Invalid binary tunnel frame.');
  const metadataSize = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  if (metadataSize > data.byteLength - 4) throw new Error('Invalid binary tunnel frame metadata.');
  const metadata = JSON.parse(decoder.decode(data.subarray(4, 4 + metadataSize))) as { type: string; streamId: string; direction?: 'request' | 'response'; binary?: boolean };
  const payload = data.slice(4 + metadataSize);
  if (metadata.type === 'body_chunk' && metadata.direction) return { type: 'body_chunk', streamId: metadata.streamId, direction: metadata.direction, data: payload };
  if (metadata.type === 'ws_message' && typeof metadata.binary === 'boolean') return { type: 'ws_message', streamId: metadata.streamId, binary: metadata.binary, data: payload };
  throw new Error('Unknown binary tunnel frame.');
}
