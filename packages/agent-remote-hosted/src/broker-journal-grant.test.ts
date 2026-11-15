import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { afterEach, describe, expect, it } from 'vitest';

import { createHostBroker } from './index.js';
import { createHostJournals, type HostJournals } from './host-journals.js';
import { collect, socketPair, until } from './test-utils/journal-session-fixture.js';

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function connected(query: string, journals: MemoryJournalStore | undefined, journalService?: HostJournals) {
  const broker = createHostBroker({ origin: 'https://relay.example', rpcTimeoutMs: 1000, ...(journalService ? { journalService } : journals ? { journals } : {}) });
  closers.push(() => broker.close());
  const pairing = await broker.handleRequest(new Request('https://relay.example/v1/remote/pairings', { method: 'POST', body: '{}' }));
  const { key } = await pairing!.json();
  const prepared = await broker.prepareUpgrade(new Request(`https://relay.example/ws/remote-host${query}`, { headers: { authorization: `Bearer ${key}` } }));
  if (!prepared || prepared instanceof Response) throw new Error('Host upgrade rejected');
  const pair = socketPair(closers);
  const inbox = collect(pair.native);
  prepared.accept(pair.server);
  pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'installation', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  const registered = await inbox.take(message => message.type === 'registered', 'registered');
  return { pair, inbox, registered };
}

const registered = async (query: string, journals: MemoryJournalStore | undefined, journalService?: HostJournals): Promise<Record<string, unknown>> =>
  (await connected(query, journals, journalService)).registered;

describe('the journal grant', () => {
  it('is acknowledged at level 2 for a Controller that asks for 2', async () => {
    expect((await registered('?journal=2', new MemoryJournalStore())).journal).toBe(2);
  });

  it('is acknowledged at level 1 for one that asks for 1, and absent for one that does not ask', async () => {
    expect((await registered('?journal=1', new MemoryJournalStore())).journal).toBe(1);
    expect((await registered('', new MemoryJournalStore())).journal).toBeUndefined();
  });

  it('grants level 1 to a Controller that asks for 2 of a journal service that reports only 1', async () => {
    const service = { ...createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 }), capabilities: async () => ({ journal: 1 as const }) };
    expect((await registered('?journal=2', undefined, service)).journal).toBe(1);
  });

  it('closes, with 1008, a connection granted 1 that sends what needs 2, and keeps one granted 2', async () => {
    const row = { itemKey: 'a', providerId: 'codex', sourceKey: 'a:1', occurredAt: 1, item: { type: 'assistant_message', text: 'Hi', messageId: 'a' } };
    const open = { uplinkVersion: 2, type: 'journal_open', requestId: 'open-1', sessionKey: 'codex:thread-1', publisherId: 'controller-1' };
    const entries = [{ sequence: 1, op: 'append', row }, { sequence: 2, op: 'rebind', itemKey: 'a', previous: { locator: 'x', resourceId: 'r1', status: 'pending' }, replacement: { locator: 'x', resourceId: 'r2', status: 'available' } }];
    for (const [query, closed] of [['?journal=1', 1008], ['?journal=2', undefined]] as const) {
      const { pair, inbox } = await connected(query, new MemoryJournalStore());
      pair.native.send(JSON.stringify(open));
      const opened = await inbox.take(message => message.type === 'journal_opened', 'journal_opened');
      pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'journal_publish', sessionKey: 'codex:thread-1', generation: opened.generation, entries }));
      if (closed) await until(() => pair.native.closeCode === closed || undefined, 'the connection to close');
      else { await inbox.take(message => message.type === 'journal_ack', 'journal_ack'); expect(pair.native.closeCode).toBeUndefined(); }
    }
  });

  it('closes, with 1008, a connection granted 1 for each message that needs 2', async () => {
    const row = { itemKey: 'a', providerId: 'codex', sourceKey: 'a:1', occurredAt: 1, item: { type: 'assistant_message', text: 'Hi', messageId: 'a' } };
    const snapshot = { id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
      capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
      pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' } };
    const sessionKey = 'codex:thread-1';
    const needsTwo: Array<(generation: number) => Record<string, unknown>> = [
      generation => ({ type: 'journal_unserve', sessionKey, generation }),
      () => ({ type: 'journal_request_refused', requestId: 'request-1', sessionKey, reason: 'not_followed' }),
      () => ({ type: 'journal_open', requestId: 'open-2', sessionKey, publisherId: 'controller-1', reset: true }),
      generation => ({ type: 'journal_publish', sessionKey, generation, entries: [{ sequence: 1, op: 'correct', row, expectedRevision: 1 }] }),
      generation => ({ type: 'journal_publish', sessionKey, generation, entries: [{ sequence: 1, op: 'replace', items: [{ row }] }] }),
      generation => ({ type: 'journal_publish', sessionKey, generation, entries: [{ sequence: 1, op: 'prepend', items: [{ row }] }] }),
      generation => ({ type: 'journal_publish', sessionKey, generation, entries: [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 1, attentionItemKey: 'a' } }] }),
      generation => ({ type: 'journal_publish', sessionKey, generation, entries: [{ sequence: 1, op: 'outcome', providerId: 'codex', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1 }] }),
    ];
    for (const message of needsTwo) {
      const { pair, inbox } = await connected('?journal=1', new MemoryJournalStore());
      pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'journal_open', requestId: 'open-1', sessionKey, publisherId: 'controller-1' }));
      const opened = await inbox.take(candidate => candidate.type === 'journal_opened', 'journal_opened');
      pair.native.send(JSON.stringify({ uplinkVersion: 2, ...message(opened.generation) }));
      await until(() => pair.native.closeCode === 1008 || undefined, `the connection to close for ${String(message(1).type)}`);
    }
  });

  it('is never acknowledged by a Relay without a journal store', async () => {
    expect((await registered('?journal=2', undefined)).journal).toBeUndefined();
  });
});
