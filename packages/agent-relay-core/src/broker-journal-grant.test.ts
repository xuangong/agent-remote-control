import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { afterEach, describe, expect, it } from 'vitest';

import { createHostBroker } from './index.js';
import type { HostJournals } from './host-journals.js';
import { collect, socketPair } from './test-utils/journal-session-fixture.js';

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
  it('is acknowledged for a Controller that asks for journal 1', async () => {
    expect((await registered('?journal=1', new MemoryJournalStore())).journal).toBe(1);
  });

  it('is not acknowledged for a Controller that does not ask or asks for another version', async () => {
    expect((await registered('', new MemoryJournalStore())).journal).toBeUndefined();
    expect((await registered('?journal=2', new MemoryJournalStore())).journal).toBeUndefined();
  });

  it('is never acknowledged by a Relay without a journal store', async () => {
    expect((await registered('?journal=1', undefined)).journal).toBeUndefined();
  });
});
