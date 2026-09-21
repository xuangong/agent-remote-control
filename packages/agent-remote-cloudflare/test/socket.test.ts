import { expect, it, vi } from 'vitest';
import { WorkerRelaySocket } from '../src/socket.js';

// Resolve the shared transport contract from source without requiring a package build.
vi.mock('@orchardworks/agent-remote-hosted', () => import('../../agent-remote-hosted/src/transport.js'));

it('receives and sends a maximum-size image preview without closing the Host socket', () => {
  class NativeSocket extends EventTarget {
    readyState = 1;
    binaryType = 'arraybuffer';
    sent: string[] = [];
    closed: number[] = [];
    send(data: string) { this.sent.push(data); }
    close(code: number) { this.closed.push(code); this.readyState = 3; }
  }
  const native = new NativeSocket();
  const socket = new WorkerRelaySocket(native as unknown as WebSocket, { waitUntil() {} });
  const byteLength = 10 * 1024 * 1024;
  const resource = { protocolVersion: '1.5.0', type: 'resource_response', payload: {
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
