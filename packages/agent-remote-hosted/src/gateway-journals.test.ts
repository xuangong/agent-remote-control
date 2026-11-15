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
function twoAccounts() {
  const initial = emptyRelayState(auth);
  for (const [subject, pending] of [['alice', 'gone-alice'], ['bob', 'gone-bob']] as const) {
    initial.tenants.push({ subject, namespace: createHash('sha256').update(JSON.stringify([auth.issuer, subject])).digest('hex'),
      broker: { keys: [], hosts: [], bindings: [], creations: [], journalDeletions: [pending] } });
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
