import { expect, it, vi } from 'vitest';
import { decodeTunnelFrame } from './codec.js';
import { TunnelOutbound } from './outbound.js';
import type { TunnelData, TunnelSocket } from './types.js';

function transport() {
  const wire: TunnelData[] = [];
  const pending: Array<{ bytes: number; resolve(): void; reject(error: Error): void }> = [];
  let buffered = 0; let peak = 0;
  const socket: TunnelSocket = {
    get bufferedAmount() { return buffered; },
    send(data) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
      buffered += bytes; peak = Math.max(peak, buffered); wire.push(data);
      return new Promise<void>((resolve, reject) => pending.push({ bytes, resolve, reject }));
    },
    close() {}, onMessage() { return () => {}; }, onClose() { return () => {}; },
  };
  const settle = (error?: Error) => { const item = pending.shift(); if (item) { buffered -= item.bytes; error ? item.reject(error) : item.resolve(); } };
  const frame = (id: string) => ({ type: 'body_chunk' as const, direction: 'response' as const, streamId: id, data: new Uint8Array(850) });
  return { socket, wire, pending, frame, settle, peak: () => peak };
}

it('reserves room for control traffic and resumes payloads in order after the socket drains', async () => {
  const t = transport(); const failures: Error[] = [];
  const writer = new TunnelOutbound(t.socket, 1024, 4096, error => failures.push(error));
  const signal = new AbortController().signal;
  const payloads = Array.from({ length: 8 }, (_, index) => writer.payload(t.frame(String(index)), signal));
  writer.control({ type: 'ping', nonce: 'alive' });
  expect(t.wire.map(data => decodeTunnelFrame(data).type)).toEqual(['body_chunk', 'body_chunk', 'body_chunk', 'ping']);
  while (t.pending.length) { t.settle(); await Promise.resolve(); }
  await Promise.all(payloads);
  expect(t.wire.map(data => decodeTunnelFrame(data)).filter(frame => frame.type === 'body_chunk').map(frame => frame.streamId)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
  expect(t.peak()).toBeLessThanOrEqual(4096); expect(failures).toEqual([]); writer.close();
});

it('removes cancelled payloads from the queue while letting other streams progress', async () => {
  const t = transport(); const writer = new TunnelOutbound(t.socket, 1024, 4096, () => {});
  const signal = new AbortController().signal;
  const first = Array.from({ length: 3 }, (_, index) => writer.payload(t.frame(String(index)), signal));
  const abort = new AbortController();
  const cancelled = writer.payload(t.frame('cancelled'), abort.signal);
  const next = writer.payload(t.frame('next'), signal);
  abort.abort(); await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
  while (t.pending.length) { t.settle(); await Promise.resolve(); }
  await Promise.all([...first, next]);
  expect(t.wire.map(data => decodeTunnelFrame(data)).filter(frame => frame.type === 'body_chunk').map(frame => frame.streamId)).toEqual(['0', '1', '2', 'next']); writer.close();
});

it('rejects in-flight and queued writes immediately when the tunnel closes', async () => {
  const t = transport(); const writer = new TunnelOutbound(t.socket, 1024, 4096, () => {});
  const writes = Array.from({ length: 8 }, (_, index) => writer.payload(t.frame(String(index)), new AbortController().signal));
  const results = Promise.allSettled(writes); writer.close();
  expect((await results).every(value => value.status === 'rejected')).toBe(true);
  await expect(writer.payload(t.frame('late'), new AbortController().signal)).rejects.toMatchObject({ code: 'closed' });
  while (t.pending.length) { t.settle(); await Promise.resolve(); }
  expect(t.wire).toHaveLength(3);
});

it('fails the tunnel on a real send error and releases every waiting producer', async () => {
  const t = transport(); const failures: Error[] = [];
  const writer = new TunnelOutbound(t.socket, 1024, 4096, error => failures.push(error));
  const results = Promise.allSettled(Array.from({ length: 8 }, (_, index) => writer.payload(t.frame(String(index)), new AbortController().signal)));
  const error = new Error('socket failed'); t.settle(error);
  expect((await results).every(value => value.status === 'rejected')).toBe(true); expect(failures).toEqual([error]);
});

it('waits for bufferedAmount to drop on transports with synchronous send and stops polling when idle', async () => {
  vi.useFakeTimers();
  try {
    let buffered = 4096; const wire: TunnelData[] = [];
    const socket: TunnelSocket = { get bufferedAmount() { return buffered; }, send(data) { wire.push(data); }, close() {}, onMessage() { return () => {}; }, onClose() { return () => {}; } };
    const writer = new TunnelOutbound(socket, 1024, 4096, () => {});
    const pending = writer.payload({ type: 'body_chunk', streamId: 'one', direction: 'response', data: new Uint8Array(850) }, new AbortController().signal);
    expect(wire).toEqual([]); buffered = 0;
    await vi.advanceTimersByTimeAsync(10); await pending;
    expect(wire).toHaveLength(1); expect(vi.getTimerCount()).toBe(0); writer.close();
  } finally { vi.useRealTimers(); }
});

it('does not dispatch a cancelled HTTP open that was waiting for writable capacity', async () => {
  vi.useFakeTimers();
  try {
    let buffered = 4096; const wire: TunnelData[] = [];
    const socket: TunnelSocket = { get bufferedAmount() { return buffered; }, send(data) { wire.push(data); }, close() {}, onMessage() { return () => {}; }, onClose() { return () => {}; } };
    const writer = new TunnelOutbound(socket, 1024, 4096, () => {});
    const abort = new AbortController();
    writer.control({ type: 'http_open', streamId: 'cancelled', previewId: 'p', method: 'POST', path: '/', headers: [], hasBody: false }, abort.signal);
    abort.abort(); buffered = 0; await vi.advanceTimersByTimeAsync(10);
    expect(wire).toEqual([]); expect(vi.getTimerCount()).toBe(0); writer.close();
  } finally { vi.useRealTimers(); }
});
