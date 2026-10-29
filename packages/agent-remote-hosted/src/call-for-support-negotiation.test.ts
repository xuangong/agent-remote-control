import { afterEach, expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';
import { createHostBroker, type RelaySocket } from './index.js';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); });

class Socket implements RelaySocket {
  readyState = 1; bufferedAmount = 0; peer!: Socket;
  messages = new Set<(data: string, binary: boolean) => void | Promise<void>>(); closes = new Set<() => void>();
  send(data: string) { queueMicrotask(() => { if (this.peer.readyState === 1) for (const listener of this.peer.messages) listener(data, false); }); }
  close() { if (this.readyState !== 1) return; this.readyState = 3; for (const listener of this.closes) listener(); this.peer.close(); }
  onMessage(listener: (data: string, binary: boolean) => void | Promise<void>) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
  onError() { return () => {}; }
}

async function register(query: string) {
  const broker = createHostBroker({ origin: 'https://relay.example', rpcTimeoutMs: 1000 });
  close.push(() => broker.close());
  const request = (path: string, body?: unknown) => new Request(`https://relay.example${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { key } = await (await broker.handleRequest(request('/v1/remote/pairings', {})))!.json();
  const prepared = await broker.prepareUpgrade(new Request(`https://relay.example/ws/remote-host?${query}`, { headers: { authorization: `Bearer ${key}` } }));
  if (!prepared || prepared instanceof Response) throw new Error('Host upgrade rejected');
  const server = new Socket(), native = new Socket(); server.peer = native; native.peer = server; close.push(() => server.close());
  const registered = new Promise<Record<string, unknown>>(resolve => native.onMessage(data => { const message = JSON.parse(data); if (message.type === 'registered') resolve(message); }));
  prepared.accept(server);
  native.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'controller', name: 'Mac',
    providers: [{ providerId: 'codex', displayName: 'Codex', readOnly: true }, { providerId: 'opencode', displayName: 'OpenCode' }] }));
  const message = await registered;
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(message)).status).toBe('ok');
  return { message, hosts: (await (await broker.handleRequest(request('/v1/remote/hosts')))!.json()).hosts };
}

it('acknowledges Call For Support only for a Host that also follows Team recipients across handoffs', async () => {
  const capable = await register('team=1&teamRecipients=1&teamSuccession=1&callForSupport=1');
  expect(capable.message).toMatchObject({ teamSuccession: 1, callForSupport: 1 });
  expect(capable.hosts[0].providers).toEqual([{ providerId: 'codex', displayName: 'Codex', readOnly: true }, { providerId: 'opencode', displayName: 'OpenCode' }]);
  expect((await register('team=1&teamRecipients=1&callForSupport=1')).message).not.toHaveProperty('callForSupport');
  expect((await register('team=1&teamRecipients=1&teamSuccession=1')).message).not.toHaveProperty('callForSupport');
});
