import type { WebSocket } from 'miniflare';
import { expect, it } from 'vitest';
import { event, fixture, send } from './fixture.js';

function socketEvent(socket: WebSocket, type: 'message' | 'close', timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const listener = (value: any) => {
      const message = type === 'message' ? JSON.parse(String(value.data)) : undefined;
      if (message?.type === 'rpc_request' && message.path === '/remote/controller-update') {
        // This legacy fixture does not support diagnostic delivery.
        send(socket, { type: 'rpc_response', requestId: message.requestId, status: 404, body: '' });
        return;
      }
      clearTimeout(timer);
      socket.removeEventListener(type, listener);
      resolve(type === 'message' ? message : value);
    };
    const timer = setTimeout(() => {
      socket.removeEventListener(type, listener);
      reject(new Error(`Socket ${type} deadline exceeded`));
    }, timeoutMs);
    socket.addEventListener(type, listener);
  });
}

it('keeps an acknowledged Host online while expiring an unacknowledged application heartbeat', async () => {
  const f = await fixture();
  const owner = await f.login('heartbeat-owner');
  async function connect(installationId: string) {
    const pairing = await (await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, {})).json() as { key: string };
    const socket = await f.upgrade('/ws/remote-host', {
      authorization: `Bearer ${pairing.key}`,
    });
    const first = event(socket, 'message');
    send(socket, { type: 'register', credentialRotation: true, installationId, name: installationId,
      providers: [{ providerId: 'codex', displayName: 'Codex' }] });
    const credential = await first;
    expect(credential.type).toBe('credential_issued');
    const registered = event(socket, 'message');
    send(socket, { type: 'credential_saved' });
    return { socket, registered: await registered };
  }
  const healthy = await connect('heartbeat-responsive');
  const silent = await connect('heartbeat-unresponsive');
  for (const host of [healthy, silent]) {
    expect(host.registered).toMatchObject({ type: 'registered', heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 } });
  }
  const acknowledged = socketEvent(healthy.socket, 'message', 40_000).then(message => {
    expect(message).toEqual({ uplinkVersion: 2, type: 'heartbeat', nonce: expect.any(String) });
    expect(message.nonce.length).toBeGreaterThan(0);
    send(healthy.socket, { type: 'heartbeat_ack', nonce: message.nonce });
  });
  const ignored = socketEvent(silent.socket, 'message', 40_000).then(message => {
    expect(message).toEqual({ uplinkVersion: 2, type: 'heartbeat', nonce: expect.any(String) });
    send(silent.socket, { type: 'heartbeat_ack', nonce: 'unrelated-heartbeat-nonce' });
  });
  const closed = socketEvent(silent.socket, 'close', 50_000);
  const [, , close] = await Promise.all([acknowledged, ignored, closed]);
  expect(close.code).toBe(1012);
  const hosts = (await (await f.json(owner.basePath + 'v1/remote/hosts', owner.cookie)).json() as {
    hosts: Array<{ id: string; online: boolean }>;
  }).hosts;
  expect(hosts.find(host => host.id === healthy.registered.hostId)?.online).toBe(true);
  expect(hosts.find(host => host.id === silent.registered.hostId)?.online).toBe(false);
  expect(healthy.socket.readyState).toBe(1);
}, 90_000);
