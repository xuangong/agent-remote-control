import { once } from 'node:events';
import { MemoryJournalStore, SessionJournal } from '@orchardworks/agent-remote-journal';
import { expect } from 'vitest';
import { WebSocketServer } from 'ws';

import { createHostBroker, type RelaySocket } from '../../../agent-relay-core/src/index.js';
import { createDiagnosticJournal } from '../../../agent-relay-core/src/diagnostic-journal.js';
import { createAgentHost, type AgentHostProviderRegistration } from '../host.js';

const closers: Array<() => Promise<void> | void> = [];
/** Closes every host this file's tests started; call it from `afterEach`. */
export async function closeHosts(): Promise<void> { for (const close of closers.splice(0).reverse()) await close(); }

/**
 * A Controller's host runtime connected to a hosted Relay over a real socket, with the Relay's real journal service and a store, and a
 * page's requests (attach, a listing, the revision check) made through the Relay as the page makes them.
 */
export async function startRelayHost(options: { registrations: AgentHostProviderRegistration[]; idleGraceMs?: number }) {
  const store = new MemoryJournalStore();
  let recorded: Array<{ event: string; reason?: string }> = [];
  const diagnostics = createDiagnosticJournal({ storage: { save: async events => { recorded = structuredClone(events) as typeof recorded; } } });
  const broker = createHostBroker({ origin: 'http://relay.test', rpcTimeoutMs: 5000, journals: store, diagnostics });
  const pairing = await broker.handleRequest(new Request('http://relay.test/v1/remote/pairings', { method: 'POST', body: '{}' }));
  const { key } = await pairing!.json();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', async (socket, request) => {
    const prepared = await broker.prepareUpgrade(new Request(`http://relay.test${request.url}`, { headers: { authorization: `Bearer ${key}` } }));
    if (!prepared || prepared instanceof Response) { socket.close(); return; }
    prepared.accept({
      get readyState() { return socket.readyState; }, get bufferedAmount() { return socket.bufferedAmount; },
      send: data => socket.send(data), close: (code, reason) => socket.close(code, reason),
      onMessage(listener) { const receive = (data: import('ws').RawData, binary: boolean) => { void listener(data.toString(), binary); }; socket.on('message', receive); return () => { socket.off('message', receive); }; },
      onClose(listener) { socket.on('close', listener); return () => { socket.off('close', listener); }; },
      onError(listener) { socket.on('error', listener); return () => { socket.off('error', listener); }; },
    } satisfies RelaySocket);
  });
  const lifecycle: string[] = [];
  const create = () => createAgentHost({
    registrations: options.registrations, installationId: 'journal-installation', name: 'Host',
    uplink: { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`, remoteKey: key },
    ...(options.idleGraceMs ? { idleGraceMs: options.idleGraceMs, idleReconcileMs: 10_000 } : {}),
    onSessionLifecycleDiagnostic: diagnostic => { lifecycle.push(diagnostic.event); },
  });
  const state = { host: create() };
  closers.push(async () => {
    await state.host.close();
    broker.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const { hostId } = await state.host.ready;
  const request = async (path: string, init?: RequestInit) => broker.handleRequest(new Request(`http://relay.test/v1/remote/hosts/${hostId}/${path}`, init));
  const agentIdOf = async (providerId: string, nativeSessionId: string): Promise<string> => {
    const response = await request('attach', { method: 'POST', body: JSON.stringify({ providerId, nativeSessionId }) });
    return String((await response!.json() as { agentId?: string }).agentId);
  };
  return {
    store, lifecycle,
    /** An operation on the attached session, as a page's send makes it: the Controller acquires the session for it. */
    acquire: async (providerId: string, nativeSessionId: string) => { await broker.handleRequest(new Request(`http://relay.test/v1/sessions/${encodeURIComponent(await agentIdOf(providerId, nativeSessionId))}/snapshot`)); },
    attach: async (providerId: string, nativeSessionId: string) => { expect((await request('attach', { method: 'POST', body: JSON.stringify({ providerId, nativeSessionId }) }))?.status).toBe(200); },
    /** What the page's directory does: a listing, or the revision check it repeats every five seconds. */
    listing: async (providerId: string, revision = false) => { expect((await request(`${revision ? 'catalog/revision' : 'catalog'}?providerId=${providerId}`))?.status).toBe(200); },
    journal: async (providerId: string, nativeSessionId: string): Promise<SessionJournal | undefined> => { const stored = await store.load(`${hostId}:${providerId}:${nativeSessionId}`); return stored ? new SessionJournal(stored) : undefined; },
    windows: () => recorded.filter(entry => entry.event === 'journal_window').map(entry => entry.reason),
    released: () => lifecycle.filter(event => event === 'session_idle_released').length,
    restart: async () => { await state.host.close(); state.host = create(); await state.host.ready; },
  };
}
