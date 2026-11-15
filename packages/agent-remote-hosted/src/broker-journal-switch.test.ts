import { MemoryJournalStore, SessionJournal, type JournalStore } from '@orchardworks/agent-remote-journal';
import { afterEach, expect, it } from 'vitest';

import { createHostBroker, type RemoteHostBrokerState } from './index.js';
import { DIGEST, HOST_ID, PUBLIC_ID, row, SESSION_KEY, seedJournal, sleep, snapshot, startRelay, STORE_KEY, type Wire } from './test-utils/journal-session-fixture.js';

const started: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const relay of started.splice(0)) await relay.dispose(); });
async function relay(options: Parameters<typeof startRelay>[0] = {}) {
  const value = await startRelay(options);
  started.push(value);
  return value;
}
type Relay = Awaited<ReturnType<typeof relay>>;

const withoutSwitch = (saved: RemoteHostBrokerState): RemoteHostBrokerState =>
  ({ ...saved, hosts: saved.hosts.map(({ smartReading: _smartReading, ...host }) => host) });
const withSwitch = (smartReading: string[]) => (saved: RemoteHostBrokerState): RemoteHostBrokerState =>
  ({ ...saved, hosts: saved.hosts.map(host => ({ ...host, smartReading })) });
const REJECTED = 'Session stream rejected: 503';

const route = (r: Pick<Relay, 'broker'>, method: string, body?: Wire) => r.broker.handleRequest(
  new Request(`https://relay.example/v1/remote/hosts/${HOST_ID}/smart-reading`, { method, headers: { 'content-type': 'application/json', origin: 'https://relay.example' }, ...(body ? { body: JSON.stringify(body) } : {}) }), {});

it('reads from the journal only while the owner has smart reading on for the provider, and closes the streams when it is turned off', async () => {
  const r = await relay({ state: withoutSwitch, seed: store => seedJournal(store) });
  await expect(r.openBrowser()).rejects.toThrow(REJECTED);
  const on = (await route(r, 'PUT', { providerId: 'codex', enabled: true }))!;
  expect(on.status).toBe(200);
  expect(await on.json()).toEqual({ providers: ['codex'] });
  const browser = await r.openBrowser();
  browser.send({ type: 'negotiate' });
  expect(await browser.take(message => message.type === 'agent_snapshot', 'Snapshot')).toMatchObject({ payload: { id: PUBLIC_ID, status: 'idle' } });
  const off = (await route(r, 'PUT', { providerId: 'codex', enabled: false }))!;
  expect(await off.json()).toEqual({ providers: [] });
  expect(browser.pair.native.closeCode).toBe(1012);
  expect(browser.pair.native.closeReason).toBe('Smart reading turned off');
  await expect(r.openBrowser()).rejects.toThrow(REJECTED);
});

it('does not read from the journal for a provider the switch does not name', async () => {
  const r = await relay({ state: withSwitch(['claude']), seed: store => seedJournal(store) });
  await expect(r.openBrowser()).rejects.toThrow(REJECTED);
});

it('does not read from the journal of a session that has none, or none with a head, even with the switch on', async () => {
  const none = await relay();
  await expect(none.openBrowser()).rejects.toThrow(REJECTED);
  const headless = await relay({ seed: store => seedJournal(store, { head: false }) });
  await expect(headless.openBrowser()).rejects.toThrow(REJECTED);
});

it('lists the providers with smart reading on and refuses a malformed change', async () => {
  const r = await relay({ state: withSwitch(['claude', 'codex']) });
  expect(await (await route(r, 'GET'))!.json()).toEqual({ providers: ['claude', 'codex'] });
  expect((await route(r, 'PUT', { providerId: 'codex' }))!.status).toBe(400);
  expect((await route(r, 'PUT', { providerId: '', enabled: true }))!.status).toBe(400);
  expect((await route(r, 'PUT', { providerId: 'codex', enabled: true, extra: 1 }))!.status).toBe(400);
  expect((await route(r, 'DELETE'))!.status).toBe(405);
  const unknown = await r.broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/nobody/smart-reading', { method: 'GET' }), {});
  expect(unknown!.status).toBe(404);
});

it('saves the switch with the Host, keeps it when the Controller registers again, and loads it back', async () => {
  let saved: RemoteHostBrokerState | undefined;
  const r = await relay({ state: withoutSwitch, broker: { onStateChange: async state => { saved = structuredClone(state); } } });
  await route(r, 'PUT', { providerId: 'codex', enabled: true });
  expect(saved!.hosts[0]).toMatchObject({ id: HOST_ID, smartReading: ['codex'] });
  await r.connectController();
  await sleep(20);
  expect(saved!.hosts[0]).toMatchObject({ id: HOST_ID, smartReading: ['codex'] });
  const again = createHostBroker({ origin: 'https://relay.example', initialState: saved!, now: () => 10_000 });
  try { expect(await (await route({ broker: again }, 'GET'))!.json()).toEqual({ providers: ['codex'] }); }
  finally { again.close(); }
  await route(r, 'PUT', { providerId: 'codex', enabled: false });
  expect(saved!.hosts[0]).not.toHaveProperty('smartReading');
});

it('takes a session out of serving when a quota refuses a publication: its streams close, a new one is read from the Controller, and the head is cleared', async () => {
  const r = await relay({ journalLimits: { sessionItems: 1 } });
  const controller = await r.connectController();
  const opened = await controller.open();
  await controller.publish([
    { op: 'append', row: row('m1', 'Hello') }, { op: 'complete', itemKey: 'm1', digest: DIGEST },
    { op: 'head', head: { snapshot: snapshot('idle', 'native-session'), observedAt: 5 } },
  ]);
  const browser = await r.openBrowser();
  browser.send({ type: 'negotiate' });
  await browser.take(message => message.type === 'agent_snapshot', 'Snapshot');
  controller.send({ type: 'journal_publish', sessionKey: SESSION_KEY, generation: opened.generation, entries: [{ sequence: 4, op: 'append', row: row('m2', 'World') }] });
  expect(await controller.inbox.take(message => message.type === 'journal_refused', 'refusal')).toMatchObject({ sequence: 4, reason: 'quota_exceeded' });
  await sleep(20);
  expect(browser.pair.native.closeCode).toBe(1012);
  expect((await r.store.load(STORE_KEY))!.meta.head).toBeUndefined();
  const crude = await r.openBrowser();
  crude.send({ type: 'negotiate' });
  expect(await crude.take(message => message.type === 'agent_snapshot', 'Snapshot')).toMatchObject({ payload: { status: 'running' } });
});

/** A broker over a store whose first deletion by prefix fails. */
function revocation(store: JournalStore, states: RemoteHostBrokerState[], initialState?: RemoteHostBrokerState) {
  return createHostBroker({ origin: 'https://relay.example', accountBacked: true, journals: store, now: () => 10_000,
    onStateChange: async state => { states.push(structuredClone(state)); },
    initialState: initialState ?? {
      keys: [], creations: [],
      hosts: [{ id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }],
      bindings: [{ hostId: HOST_ID, providerId: 'codex', nativeSessionId: 'native-session', agentId: PUBLIC_ID }],
    } });
}
const revoke = (broker: ReturnType<typeof revocation>) => broker.handleRequest(new Request(`https://relay.example/v1/remote/hosts/${HOST_ID}/revoke`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://relay.example' }, body: '{}' }), {});

async function otherHostJournal(store: MemoryJournalStore) {
  const other = SessionJournal.create('other-host:codex:native-session');
  const { generation } = other.claim('controller-1');
  other.append({ publisherId: 'controller-1', generation, sequence: 1 }, row('m1', 'Hello'));
  await store.apply(other.takeChanges()!);
}

it('deletes the journals of a Host when the owner revokes it, and no other, recording the deletion in the same commit', async () => {
  const store = new MemoryJournalStore();
  await seedJournal(store);
  await otherHostJournal(store);
  const states: RemoteHostBrokerState[] = [];
  const broker = revocation(store, states);
  try {
    expect((await revoke(broker))!.status).toBe(200);
    expect(states[0]!.journalDeletions).toEqual([HOST_ID]);
    expect(states[0]!.hosts).toEqual([]);
    await sleep(30);
    expect((await store.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual(['other-host:codex:native-session']);
    expect(states.at(-1)).not.toHaveProperty('journalDeletions');
  } finally { broker.close(); }
});

it('keeps a deletion the store failed in the saved state and finishes it when the Relay starts again', async () => {
  const memory = new MemoryJournalStore();
  await seedJournal(memory);
  let failures = 1;
  const store: JournalStore = { load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
    catalog: { list: prefix => memory.catalog.list(prefix), deletePrefix: async prefix => { if (failures-- > 0) throw new Error('disk unavailable'); await memory.catalog.deletePrefix(prefix); } } };
  const states: RemoteHostBrokerState[] = [];
  const first = revocation(store, states);
  try {
    expect((await revoke(first))!.status).toBe(200);
    await sleep(30);
    expect((await memory.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual([`${HOST_ID}:${SESSION_KEY}`]);
    expect(states.at(-1)!.journalDeletions).toEqual([HOST_ID]);
  } finally { first.close(); }
  const restarted: RemoteHostBrokerState[] = [];
  const second = revocation(store, restarted, states.at(-1));
  try {
    await sleep(30);
    expect(await memory.catalog.list('')).toEqual([]);
    expect(restarted.at(-1)).not.toHaveProperty('journalDeletions');
  } finally { second.close(); }
});

it('finishes the deletion of a Host revoked while another deletion runs, without waiting for the next start', async () => {
  const memory = new MemoryJournalStore();
  await seedJournal(memory);
  const other = SessionJournal.create('host-2:codex:native-session');
  const { generation } = other.claim('controller-1');
  other.append({ publisherId: 'controller-1', generation, sequence: 1 }, row('m1', 'Hello'));
  await memory.apply(other.takeChanges()!);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store: JournalStore = { load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
    catalog: { list: prefix => memory.catalog.list(prefix), deletePrefix: async prefix => { await gate; await memory.catalog.deletePrefix(prefix); } } };
  const states: RemoteHostBrokerState[] = [];
  const broker = revocation(store, states, {
    keys: [], creations: [], bindings: [{ hostId: HOST_ID, providerId: 'codex', nativeSessionId: 'native-session', agentId: PUBLIC_ID }],
    hosts: [
      { id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false },
      { id: 'host-2', installationId: 'second-installation', name: 'Second Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false },
    ],
  });
  try {
    expect((await revoke(broker))!.status).toBe(200);
    expect((await broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/host-2/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://relay.example' }, body: '{}' }), {}))!.status).toBe(200);
    expect(states.at(-1)!.journalDeletions).toEqual([HOST_ID, 'host-2']);
    release();
    await sleep(50);
    expect(await memory.catalog.list('')).toEqual([]);
    expect(states.at(-1)).not.toHaveProperty('journalDeletions');
  } finally { broker.close(); }
});

it('deletes the pending journals of a Host before it is told it is registered, so its new journal is not deleted afterwards', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const r = await relay({
    state: saved => ({ ...saved, journalDeletions: [HOST_ID] }),
    seed: store => seedJournal(store),
    journalStore: memory => ({ load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
      catalog: { list: prefix => memory.catalog.list(prefix), deletePrefix: async prefix => { await gate; await memory.catalog.deletePrefix(prefix); } } }),
  });
  let registered = false;
  const connecting = r.connectController().then(controller => { registered = true; return controller; });
  await sleep(60);
  expect(registered).toBe(false);
  release();
  const controller = await connecting;
  const opened = await controller.open();
  expect(opened).toMatchObject({ watermark: 0, index: [] });
  await sleep(30);
  expect((await r.store.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual([STORE_KEY]);
});
