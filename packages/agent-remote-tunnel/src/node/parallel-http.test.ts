import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { createPreviewRelayBridge, createTunnelPeer, type TunnelSocket } from '../index.js';
import { createLoopbackTunnelHandlers } from './index.js';

it('queues a module-loading burst without overflowing or disconnecting the tunnel', async () => {
  const payload = Buffer.alloc(128 * 1024, 97);
  const requested: string[] = [];
  let active = 0; let peak = 0;
  const local = createServer((req, res) => {
    requested.push(req.url!); active++; peak = Math.max(peak, active);
    setTimeout(() => { active--; res.end(payload); }, 25);
  });
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const accepted = once(wss, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
  const [server] = await accepted as [WebSocket]; await once(client, 'open');
  const closeReasons: string[] = [];
  const wrap = (socket: WebSocket): TunnelSocket => ({
    get bufferedAmount() { return socket.bufferedAmount; },
    send: data => new Promise<void>((resolve, reject) => socket.send(data, { binary: data instanceof Uint8Array }, error => error ? reject(error) : resolve())),
    onMessage(listener) { const receive = (data: Buffer, binary: boolean) => listener(binary ? new Uint8Array(data) : data.toString()); socket.on('message', receive); return () => { socket.off('message', receive); }; },
    onClose(listener) { const close = (code: number, reason: Buffer) => { closeReasons.push(reason.toString()); listener(code, reason.toString()); }; socket.on('close', close); return () => { socket.off('close', close); }; },
    close: (code, reason) => socket.close(code, reason),
  });
  const controller = createTunnelPeer(wrap(client), createLoopbackTunnelHandlers({ lookup: () => ({ target: `http://127.0.0.1:${(local.address() as { port: number }).port}`, pathMode: 'strip' }) }));
  const relay = createTunnelPeer(wrap(server), {});
  const bridge = createPreviewRelayBridge(relay, id => ({ id, status: 'active' }));
  try {
    const results = await Promise.allSettled(Array.from({ length: 128 }, async (_, i) => {
      const response = await bridge.fetch('p', { method: 'GET', path: `/module-${i}.js`, headers: [] });
      return (await new Response(response.body).arrayBuffer()).byteLength;
    }));
    const errors = results.filter(x => x.status === 'rejected').map(x => String((x as PromiseRejectedResult).reason));
    expect([...new Set(errors)]).toEqual([]);
    expect(closeReasons).toEqual([]);
    expect(peak).toBeGreaterThan(8);
    expect(results.map(x => (x as PromiseFulfilledResult<number>).value)).toEqual(Array(128).fill(payload.byteLength));
    const held = await Promise.all(Array.from({ length: 48 }, (_, i) => bridge.fetch('p', { method: 'GET', path: `/held-${i}`, headers: [] })));
    const abort = new AbortController();
    const cancelled = bridge.fetch('p', { method: 'GET', path: '/cancelled', headers: [], signal: abort.signal });
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    expect(requested).not.toContain('/cancelled');
    let resumed = false;
    const queued = bridge.fetch('p', { method: 'GET', path: '/after-body', headers: [] }).then(response => { resumed = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(resumed).toBe(false);
    await held[0]!.body!.cancel();
    expect((await new Response((await queued).body).arrayBuffer()).byteLength).toBe(payload.byteLength);
    await Promise.all(held.slice(1).map(response => new Response(response.body).arrayBuffer()));
  } finally {
    bridge.close(); controller.close(); client.terminate(); server.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    local.closeAllConnections(); await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 20000);
