import { BROKER_MAX_FRAME_BYTES } from '@orchardworks/agent-relay-core';
import { expect, it } from 'vitest';
import { WorkerRelaySocket } from '../src/socket.js';

class NativeSocket extends EventTarget {
  readyState = 1;
  binaryType = 'arraybuffer';
  sent: string[] = [];
  closed: number[] = [];
  send(data: string) { this.sent.push(data); }
  close(code: number) { this.closed.push(code); this.readyState = 3; }
}

it('receives and sends a maximum-size image preview without closing the Host socket', () => {
  const native = new NativeSocket();
  const socket = new WorkerRelaySocket(native as unknown as WebSocket, { waitUntil() {} });
  const byteLength = 10 * 1024 * 1024;
  const resource = { protocolVersion: '1.8.0', type: 'resource_response', payload: {
    requestId: 'r', agentId: 'a', resourceId: 'image', state: { status: 'available', mediaType: 'image/png',
      sha256: 'a'.repeat(64), byteLength, contentBase64: Buffer.alloc(byteLength).toString('base64') },
  } };
  const frame = JSON.stringify({ uplinkVersion: 2, type: 'stream_message', streamId: 's', message: JSON.stringify(resource) });
  const received: string[] = [];
  socket.onMessage(data => { received.push(data); });
  native.dispatchEvent(new MessageEvent('message', { data: frame }));
  socket.send(frame);
  expect(received).toEqual([frame]);
  expect(native.sent).toEqual([frame]);
  expect(native.closed).toEqual([]);
  expect(socket.readyState).toBe(1);
});

it('closes with 1009 on an oversized native frame, in either direction, without delivering it', () => {
  const native = new NativeSocket();
  const socket = new WorkerRelaySocket(native as unknown as WebSocket, { waitUntil() {} });
  const received: string[] = [];
  socket.onMessage(data => { received.push(data); });
  native.dispatchEvent(new MessageEvent('message', { data: 'x'.repeat(BROKER_MAX_FRAME_BYTES + 1) }));
  expect(received).toEqual([]);
  expect(native.closed).toEqual([1009]);
  const other = new NativeSocket();
  new WorkerRelaySocket(other as unknown as WebSocket, { waitUntil() {} }).send('x'.repeat(BROKER_MAX_FRAME_BYTES + 1));
  expect(other.sent).toEqual([]); expect(other.closed).toEqual([1009]);
});

it('tells the Relay the close code and whether the close was clean', () => {
  const native = new NativeSocket();
  const socket = new WorkerRelaySocket(native as unknown as WebSocket, { waitUntil() {} });
  const closes: unknown[] = [];
  socket.onClose(details => { closes.push(details); });
  native.dispatchEvent(Object.assign(new Event('close'), { code: 1000, wasClean: true, reason: 'private reason' }));
  expect(closes).toEqual([{ code: 1000, wasClean: true }]);
});
