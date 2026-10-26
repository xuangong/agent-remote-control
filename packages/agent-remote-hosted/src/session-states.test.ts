import { afterEach, expect, it } from 'vitest';
import { createHostBroker, type RelaySocket } from './index.js';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); });

function transportPair() {
  class Socket implements RelaySocket {
    readyState = 1; bufferedAmount = 0; closeCode?: number; peer!: Socket;
    messages = new Set<(data: string, binary: boolean) => void | Promise<void>>(); closes = new Set<() => void>();
    send(data: string) {
      if (this.readyState !== 1) throw new Error('Socket is closed');
      queueMicrotask(() => { if (this.peer.readyState === 1) for (const listener of this.peer.messages) listener(data, false); });
    }
    close(code?: number) {
      if (this.readyState !== 1) return;
      this.readyState = 3; this.closeCode = code;
      for (const listener of this.closes) listener();
      this.peer.close(code);
    }
    onMessage(listener: (data: string, binary: boolean) => void | Promise<void>) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
    onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
    onError() { return () => {}; }
  }
  const server = new Socket(), native = new Socket(); server.peer = native; native.peer = server;
  close.push(() => server.close());
  return { server, native };
}

async function connectedHost(statesRequested: boolean, options: { ownerSubject?: string } = {}) {
  let clock = 1_000, notifications = 0;
  const broker = createHostBroker({ origin: 'https://relay.example', rpcTimeoutMs: 1000, now: () => clock, onSessionStates: () => { notifications++; }, ...options });
  close.push(() => broker.close());
  const pairing = await (await broker.handleRequest(new Request('https://relay.example/v1/remote/pairings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), options.ownerSubject ? { principalSubject: () => options.ownerSubject } : {}))!.json();
  const prepared = await broker.prepareUpgrade(new Request(`https://relay.example/ws/remote-host${statesRequested ? '?sessionStates=1' : ''}`, { headers: { authorization: `Bearer ${pairing.key}` } }));
  if (!prepared || prepared instanceof Response) throw new Error('Host upgrade rejected');
  const pair = transportPair();
  const registered = new Promise<{ hostId: string; sessionStates?: number }>(resolve => pair.native.onMessage(data => { const message = JSON.parse(data); if (message.type === 'registered') resolve(message); }));
  prepared.accept(pair.server);
  pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'native', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  const host = await registered;
  const report = async (fields: Record<string, unknown>) => { pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'session_states', full: false, states: [], ...fields })); await new Promise(resolve => setTimeout(resolve, 5)); };
  return { broker, pair, host, report, notifications: () => notifications, advance: (ms: number) => { clock += ms; } };
}

const thread = (state: string, updatedAt = 5) => ({ providerId: 'codex', nativeSessionId: 'thread', state, updatedAt });

it('keeps the latest session states of a Host that reports them and forgets them when it disconnects', async () => {
  const { broker, pair, host, report, notifications, advance } = await connectedHost(true);
  expect(host.sessionStates).toBe(1);
  expect(broker.sessionStates('anyone')).toEqual([{ hostId: host.hostId, online: true, states: [] }]);
  await report({ full: true, states: [thread('running'), { providerId: 'codex', nativeSessionId: 'other', state: 'idle' }] });
  expect(broker.sessionStates('anyone')).toEqual([{ hostId: host.hostId, online: true, confirmedAt: 1_000, states: [
    { ...thread('running'), changedAt: 1_000 }, { providerId: 'codex', nativeSessionId: 'other', state: 'idle', changedAt: 1_000 }] }]);
  advance(500);
  await report({ states: [thread('waiting')], removed: [{ providerId: 'codex', nativeSessionId: 'other' }] });
  expect(broker.sessionStates('anyone')[0]).toMatchObject({ confirmedAt: 1_000, states: [{ ...thread('waiting'), changedAt: 1_500 }] });
  advance(60_000);
  // A complete report confirms the Host and keeps when unchanged states last changed.
  await report({ full: true, states: [thread('waiting')] });
  expect(broker.sessionStates('anyone')[0]).toMatchObject({ confirmedAt: 61_500, states: [{ ...thread('waiting'), changedAt: 1_500 }] });
  const before = notifications();
  pair.native.close(1000);
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(broker.sessionStates('anyone')).toEqual([{ hostId: host.hostId, online: false, states: [] }]);
  expect(notifications()).toBeGreaterThan(before);
});

it('closes a Host that reports states the Relay did not acknowledge, and shows nothing to other subjects', async () => {
  const { broker, pair, host, report } = await connectedHost(false);
  expect(host.sessionStates).toBeUndefined();
  await report({ full: true, states: [thread('running')] });
  expect(pair.server.closeCode).toBe(1008);
  const owned = await connectedHost(true, { ownerSubject: 'owner' });
  await owned.report({ full: true, states: [thread('running')] });
  expect(owned.broker.sessionStates('owner')[0]!.states).toHaveLength(1);
  expect(owned.broker.sessionStates('stranger')).toEqual([]);
  expect(broker.sessionStates('anyone')[0]!.states).toEqual([]);
});
