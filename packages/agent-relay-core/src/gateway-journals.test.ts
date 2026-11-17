import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { createHostedRelay } from './gateway.js';
import { emptyRelayState } from './state.js';
import type { RelayScheduler } from './scheduler.js';
import * as hostJournals from './host-journals.js';

vi.mock('./host-journals.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./host-journals.js')>();
  return { ...actual, createHostJournals: vi.fn(actual.createHostJournals) };
});

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'portable-relay-secret-01234567890123456789' };
const scheduler: RelayScheduler = { schedule() {}, cancel() {} };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { vi.mocked(hostJournals.createHostJournals).mockClear(); for (const close of closers.splice(0).reverse()) await close(); });

/** A durable state with two accounts, each with a Host revoked earlier whose journals are still to be deleted. */
function twoAccounts(pending = 1) {
  const initial = emptyRelayState(auth);
  for (const subject of ['alice', 'bob']) {
    initial.tenants.push({ subject, namespace: createHash('sha256').update(JSON.stringify([auth.issuer, subject])).digest('hex'),
      broker: { keys: [], hosts: [], bindings: [], creations: [], journalDeletions: Array.from({ length: pending }, (_, at) => pending === 1 ? `gone-${subject}` : `gone-${subject}-${at}`) } });
  }
  return { initial, async commit() {} };
}

it('builds one journal service for every account of a Relay', async () => {
  const relay = createHostedRelay({ ...auth, scheduler, journals: new MemoryJournalStore(), storage: twoAccounts() });
  closers.push(() => relay.close());
  expect(hostJournals.createHostJournals).toHaveBeenCalledTimes(1);
});

it('hands a journal service built elsewhere to every account, and builds none of its own', async () => {
  const deleted: string[] = [];
  const journalService = { deleteHost: async (hostId: string) => { deleted.push(hostId); }, loadAllServed: async () => undefined } as unknown as hostJournals.HostJournals;
  const relay = createHostedRelay({ ...auth, scheduler, journalService, storage: twoAccounts() });
  closers.push(() => relay.close());
  await vi.waitFor(() => expect(deleted.sort()).toEqual(['gone-alice', 'gone-bob']));
  expect(hostJournals.createHostJournals).not.toHaveBeenCalled();
});

it('deletes the pending Hosts of every account through the one store, one at a time for each account', async () => {
  const memory = new MemoryJournalStore();
  let running = 0, peak = 0;
  const journals = { load: (key: string) => memory.load(key), apply: memory.apply.bind(memory), delete: (key: string) => memory.delete(key),
    catalog: { list: (prefix: string) => memory.catalog.list(prefix), deletePrefix: async (prefix: string) => {
      running += 1; peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 15));
      await memory.catalog.deletePrefix(prefix);
      running -= 1;
    } } };
  const state = twoAccounts(6);
  const relay = createHostedRelay({ ...auth, scheduler, journals, storage: state });
  closers.push(() => relay.close());
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(await memory.catalog.list('')).toEqual([]);
  expect(peak).toBe(2);
});
