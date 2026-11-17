import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { AgentProviderAdapter } from '@orchardworks/agent-provider-sdk';
import { MemoryJournalStore, SessionJournal } from '@orchardworks/agent-remote-journal';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { createHostBroker, type RelaySocket } from '@orchardworks/agent-relay-core';
import { createAgentHost, type AgentHostDirectory } from './host.js';
import type { JournalPublisherDiagnostic } from './journal-publisher.js';
import { boundary, item, ScriptedSession, untilReal as until } from './test-utils/journal-scripted-session.js';

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

const SESSION = 'fake:thread-1';
const history = () => [item('history', 'm1', 'Hello'), item('history', 'm2', 'World'), boundary()];

async function start(options: { capable: boolean; relayKeepsJournals?: false; idleGraceMs?: number; diagnostics?: unknown[] }) {
  const store = new MemoryJournalStore();
  // A Relay built with default options keeps no journals.
  const broker = createHostBroker({ origin: 'http://relay.test', rpcTimeoutMs: 1000, ...(options.relayKeepsJournals === false ? {} : { journals: store }) });
  const pairing = await broker.handleRequest(new Request('http://relay.test/v1/remote/pairings', { method: 'POST', body: '{}' }));
  const { key } = await pairing!.json();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const requests: IncomingMessage[] = [];
  server.on('connection', async (socket, request) => {
    requests.push(request);
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
  const sessions: ScriptedSession[] = [];
  const adapter: AgentProviderAdapter = {
    descriptor: { providerId: 'fake', displayName: 'Fake' },
    ...(options.capable ? { journal: { itemIdentity: 1 as const } } : {}),
    async createSession() { throw new Error('The Host supplies directory sessions.'); },
    async resumeSession() { throw new Error('The Host supplies directory sessions.'); },
  };
  const directory: AgentHostDirectory = {
    providerId: 'fake', list: async () => [], workspaces: async () => [], create: async () => 'thread-1',
    canReleaseSession: () => true,
    async open(nativeSessionId) { const session = new ScriptedSession('fake', nativeSessionId, history()); sessions.push(session); return session; },
    async close() { await Promise.all(sessions.map(session => session.dispose())); },
  };
  const lifecycle: string[] = [];
  const host = createAgentHost({
    registrations: [{ adapter, directory }], installationId: 'journal-installation', name: 'Host',
    uplink: { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`, remoteKey: key },
    ...(options.idleGraceMs ? { idleGraceMs: options.idleGraceMs, idleReconcileMs: 10_000 } : {}),
    onSessionLifecycleDiagnostic: diagnostic => { lifecycle.push(diagnostic.event); },
    ...(options.diagnostics ? { onJournalDiagnostic: (diagnostic: JournalPublisherDiagnostic) => { options.diagnostics!.push(diagnostic); } } : {}),
  });
  closers.push(async () => {
    await host.close();
    broker.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const { hostId } = await host.ready;
  const attach = async () => {
    const response = await broker.handleRequest(new Request(`http://relay.test/v1/remote/hosts/${hostId}/attach`, { method: 'POST', body: JSON.stringify({ providerId: 'fake', nativeSessionId: 'thread-1' }) }));
    expect(response?.status).toBe(200);
  };
  const journal = async (): Promise<SessionJournal | undefined> => {
    const state = await store.load(`${hostId}:${SESSION}`);
    return state ? new SessionJournal(state) : undefined;
  };
  return { host, store, attach, journal, sessions, requests, lifecycle };
}

describe('the Controller publishing its sessions over the real uplink', () => {
  it('asks the Relay for journals and publishes an attached session, history and live rows, to its journal', async () => {
    const run = await start({ capable: true });
    await run.attach();
    expect(new URL(run.requests[0]!.url!, 'http://relay').searchParams.get('journal')).toBe('1');
    await until(async () => (await run.journal())?.head !== undefined, 'the head');
    let journal = (await run.journal())!;
    expect(journal.state().items.map(entry => [entry.itemKey, entry.state])).toEqual([['m1', 'complete'], ['m2', 'complete']]);
    run.sessions[0]!.push(item('live', 'a', 'Wor', { completes: false }));
    run.sessions[0]!.push(item('live', 'a', 'ld', { completes: true }));
    await until(async () => (await run.journal())?.state().items.find(entry => entry.itemKey === 'a')?.state === 'complete', 'the live item');
    journal = (await run.journal())!;
    const page = journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false });
    expect(page.kind === 'page' && page.page.payload.entries.map(entry => 'text' in entry.item ? entry.item.text : '')).toEqual(['Hello', 'World', 'World']);
  });

  it('keeps the epoch and every row when an idle session is released and woken again (T6)', async () => {
    const run = await start({ capable: true, idleGraceMs: 60 });
    await run.attach();
    await until(async () => (await run.journal())?.head !== undefined, 'the head');
    const before = (await run.journal())!;
    await until(() => run.lifecycle.includes('session_idle_released'), 'the idle release', 6000);
    await run.attach();
    await until(() => run.sessions.length === 2, 'the second opening');
    await until(async () => ((await run.journal())?.publisher?.generation ?? 0) > (before.publisher?.generation ?? 0), 'the journal to be opened again');
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    const after = (await run.journal())!;
    expect(after.epoch).toBe(before.epoch);
    expect(after.state().items.map(entry => [entry.itemKey, entry.seqStart])).toEqual(before.state().items.map(entry => [entry.itemKey, entry.seqStart]));
    expect(after.cursor).toEqual(before.cursor);
  });

  it('does not ask for journals, and publishes nothing, when no provider declares support', async () => {
    const run = await start({ capable: false });
    await run.attach();
    expect(new URL(run.requests[0]!.url!, 'http://relay').searchParams.get('journal')).toBeNull();
    await new Promise<void>(resolve => setTimeout(resolve, 150));
    expect(await run.journal()).toBeUndefined();
  });

  it('asks for journals but publishes nothing when the Relay keeps none, as a Relay with default options does', async () => {
    const run = await start({ capable: true, relayKeepsJournals: false });
    await run.attach();
    expect(new URL(run.requests[0]!.url!, 'http://relay').searchParams.get('journal')).toBe('1');
    await new Promise<void>(resolve => setTimeout(resolve, 150));
    expect(await run.journal()).toBeUndefined();
    expect(run.sessions).toHaveLength(1);
  });

  it('records what it cannot publish as diagnostics, without content', async () => {
    const diagnostics: JournalPublisherDiagnostic[] = [];
    const run = await start({ capable: true, diagnostics });
    await run.attach();
    await until(async () => (await run.journal())?.head !== undefined, 'the head');
    run.sessions[0]!.push(item('live', 'bad', 'secret text', { turnId: 't'.repeat(600) }));
    await until(() => diagnostics.length > 0, 'the diagnostic');
    expect(diagnostics).toEqual([{ event: 'journal_row_rejected', providerId: 'fake' }]);
  });
});
