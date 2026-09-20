import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { createTunnelPeer, type TunnelData, type TunnelSocket } from '../index.js';
import { createLoopbackTunnelHandlers } from './index.js';

it('backpressures concurrent uploads and downloads on a slow real socket without losing bytes', async () => {
  const payload = Buffer.from(Array.from({ length: 32 * 1024 }, (_, index) => index % 251));
  const local = createServer((req, res) => req.method === 'POST' ? req.pipe(res) : res.end(payload));
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(wss, 'listening');
  const accepted = once(wss, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
  const [server] = await accepted as [WebSocket]; await once(client, 'open');
  const queued = [0, 0]; const peak = [0, 0]; const closes: string[] = [];
  const maxQueuedBytes = 16 * 1024;
  const wrap = (socket: WebSocket, side: number): TunnelSocket => ({
    get bufferedAmount() { return queued[side]!; },
    send(data: TunnelData) {
      const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
      queued[side]! += bytes; peak[side] = Math.max(peak[side]!, queued[side]!);
      return new Promise<void>((resolve, reject) => socket.send(data, { binary: data instanceof Uint8Array }, error => {
        setTimeout(() => { queued[side]! -= bytes; error ? reject(error) : resolve(); }, 5);
      }));
    },
    onMessage(listener) { const receive = (data: Buffer, binary: boolean) => listener(binary ? new Uint8Array(data) : data.toString()); socket.on('message', receive); return () => { socket.off('message', receive); }; },
    onClose(listener) { const close = (code: number, reason: Buffer) => { closes.push(reason.toString()); listener(code, reason.toString()); }; socket.on('close', close); return () => { socket.off('close', close); }; },
    close: (code, reason) => socket.close(code, reason),
  });
  const limits = { maxQueuedBytes, maxFrameBytes: 4096, initialCreditBytes: 2048 };
  const controller = createTunnelPeer(wrap(client, 0), createLoopbackTunnelHandlers({ lookup: () => ({ target: `http://127.0.0.1:${(local.address() as { port: number }).port}`, pathMode: 'strip' }) }), limits);
  const relay = createTunnelPeer(wrap(server, 1), {}, limits);
  try {
    const results = await Promise.allSettled(Array.from({ length: 32 }, async (_, index) => {
      const response = await relay.openHttp({ previewId: 'p', method: index % 2 ? 'POST' : 'GET', path: `/module-${index}`, headers: [],
        ...(index % 2 ? { body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(payload); c.close(); } }) } : {}) });
      return Buffer.from(await new Response(response.body).arrayBuffer());
    }));
    expect([...new Set(results.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []))]).toEqual([]);
    for (const result of results) expect((result as PromiseFulfilledResult<Buffer>).value.equals(payload)).toBe(true);
    expect(peak.every(value => value <= maxQueuedBytes)).toBe(true);
    expect(closes).toEqual([]);
  } finally {
    relay.close(); controller.close(); client.terminate(); server.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    local.closeAllConnections(); await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 20000);
