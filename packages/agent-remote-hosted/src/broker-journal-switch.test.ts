import { MemoryJournalStore, SessionJournal, type JournalStore } from '@orchardworks/agent-remote-journal';
import { afterEach, expect, it } from 'vitest';

import { createHostBroker, type RemoteHostBrokerState } from './index.js';
import { DIGEST, HOST_ID, PUBLIC_ID, row, SESSION_KEY, seedJournal, sleep, snapshot, socketPair, startRelay, STORE_KEY, type Wire } from './test-utils/journal-session-fixture.js';

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

const route = (r: Pick<Relay, 'broker'>, method: string, body?: Wire, context: Parameters<Relay['broker']['handleRequest']>[1] = {}) => r.broker.handleRequest(
  new Request(`https://relay.example/v1/remote/hosts/${HOST_ID}/smart-reading`, { method, headers: { 'content-type': 'application/json', origin: 'https://relay.example' }, ...(body ? { body: JSON.stringify(body) } : {}) }), context);

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

/** A store whose deletion by prefix is decided by the test: it answers, fails, or never answers per Host prefix. */
function storeDeleting(memory: MemoryJournalStore, decide: (prefix: string) => 'delete' | 'fail' | 'hang'): JournalStore {
  return { load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
    catalog: { list: prefix => memory.catalog.list(prefix), deletePrefix: async prefix => {
      const decision = decide(prefix);
      if (decision === 'hang') return new Promise<void>(() => undefined);
      if (decision === 'fail') throw new Error('disk unavailable');
      await memory.catalog.deletePrefix(prefix);
    } } };
}
async function goneJournal(store: MemoryJournalStore, hostId: string) {
  const journal = SessionJournal.create(`${hostId}:codex:native-session`);
  const { generation } = journal.claim('controller-1');
  journal.append({ publisherId: 'controller-1', generation, sequence: 1 }, row('m1', 'Hello'));
  await store.apply(journal.takeChanges()!);
}
const registeredOf = (controller: { inbox: { all: Wire[] } }) => controller.inbox.all.find(message => message.type === 'registered')!;

it('does not serve a stream whose switch was turned off while the Host was loading', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const r = await relay({ seed: store => seedJournal(store),
    journalStore: memory => ({ load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
      catalog: { list: async prefix => { await gate; return memory.catalog.list(prefix); }, deletePrefix: prefix => memory.catalog.deletePrefix(prefix) } }) });
  const opening = r.openBrowser().then(() => 'opened', () => 'rejected');
  await sleep(30);
  expect((await route(r, 'PUT', { providerId: 'codex', enabled: false }))!.status).toBe(200);
  release();
  expect(await opening).toBe('rejected');
});

it('closes a stream with 1012 when the switch is turned off between preparing the upgrade and accepting it', async () => {
  const r = await relay({ seed: store => seedJournal(store) });
  const prepared = await r.broker.prepareUpgrade(new Request(`https://relay.example/v1/sessions/${PUBLIC_ID}/events`, { headers: { origin: 'https://relay.example' } }), {});
  if (!prepared || prepared instanceof Response) throw new Error('rejected');
  expect((await route(r, 'PUT', { providerId: 'codex', enabled: false }))!.status).toBe(200);
  const pair = socketPair(r.closers);
  prepared.accept(pair.server);
  expect(pair.native.closeCode).toBe(1012);
  expect(pair.native.closeReason).toBe('Smart reading turned off');
});

it('refuses a 65th provider before anything is written, and keeps the bound under concurrent changes', async () => {
  const names = (count: number) => Array.from({ length: count }, (_, at) => `provider-${String(at).padStart(2, '0')}`);
  const full: RemoteHostBrokerState[] = [];
  const a = await relay({ state: withSwitch(names(64)), broker: { onStateChange: async state => { full.push(structuredClone(state)); } } });
  const refused = (await route(a, 'PUT', { providerId: 'provider-new', enabled: true }))!;
  expect(refused.status).toBe(400);
  expect(full).toEqual([]);
  expect((await route(a, 'PUT', { providerId: 'provider-00', enabled: true }))!.status).toBe(200);
  const saved: RemoteHostBrokerState[] = [];
  const b = await relay({ state: withSwitch(names(63)), broker: { onStateChange: async state => { saved.push(structuredClone(state)); } } });
  const answers = await Promise.all([route(b, 'PUT', { providerId: 'x', enabled: true }), route(b, 'PUT', { providerId: 'y', enabled: true })]);
  expect(answers.map(answer => answer!.status).sort()).toEqual([200, 400]);
  expect(saved.every(state => state.hosts[0]!.smartReading!.length <= 64)).toBe(true);
});

it('refuses a change of the switch that the mutation policy rejects, and writes nothing', async () => {
  const saved: RemoteHostBrokerState[] = [];
  const r = await relay({ state: withoutSwitch, broker: { onStateChange: async state => { saved.push(structuredClone(state)); } } });
  const rejected = (await route(r, 'PUT', { providerId: 'codex', enabled: true }, { validateMutation: () => ({ status: 'rejected', httpStatus: 403, code: 'csrf', message: 'No.' }) as never }))!;
  expect(rejected.status).toBe(403);
  expect(saved).toEqual([]);
});

it('refuses a change of the switch when the Relay keeps no journals', async () => {
  const broker = createHostBroker({ origin: 'https://relay.example', now: () => 10_000, initialState: { keys: [], creations: [], bindings: [],
    hosts: [{ id: HOST_ID, installationId: 'machine', name: 'Machine', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }] } });
  try {
    const answer = (await route({ broker }, 'PUT', { providerId: 'codex', enabled: true }))!;
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ code: 'journals_unavailable' });
  } finally { broker.close(); }
});

it('refuses a change of the switch of a Host revoked while it waited, as revoked', async () => {
  const states: RemoteHostBrokerState[] = [];
  const broker = revocation(new MemoryJournalStore(), states);
  try {
    const revoking = revoke(broker);
    const changing = route({ broker }, 'PUT', { providerId: 'codex', enabled: true });
    expect((await revoking)!.status).toBe(200);
    expect((await changing)!.status).toBe(401);
  } finally { broker.close(); }
});

it('makes room for a revoke when the list of pending deletions is full: it drops the oldest, tells the diagnostics, and the revoke succeeds', async () => {
  const pending = Array.from({ length: 1024 }, (_, at) => `old-${at}`);
  const states: RemoteHostBrokerState[] = [];
  const events: string[] = [];
  const memory = new MemoryJournalStore();
  const broker = createHostBroker({ origin: 'https://relay.example', accountBacked: true, journals: storeDeleting(memory, () => 'hang'), now: () => 10_000,
    diagnostics: { record: (_hostId: string, details: { event: string }) => { events.push(details.event); } } as never,
    onStateChange: async state => { states.push(structuredClone(state)); },
    initialState: { keys: [], creations: [], journalDeletions: pending,
      hosts: [{ id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }],
      bindings: [{ hostId: HOST_ID, providerId: 'codex', nativeSessionId: 'native-session', agentId: PUBLIC_ID }] } });
  try {
    expect((await revoke(broker))!.status).toBe(200);
    const list = states[0]!.journalDeletions!;
    expect(list).toHaveLength(1024);
    expect(list).not.toContain('old-0');
    expect(list.slice(-2)).toEqual(['old-1023', HOST_ID]);
    expect(events).toContain('journal_deletion_dropped');
  } finally { broker.close(); }
});

it('deletes every pending Host of a round, not only the first', async () => {
  const memory = new MemoryJournalStore();
  await goneJournal(memory, 'gone-1');
  await goneJournal(memory, 'gone-2');
  await goneJournal(memory, 'gone-3');
  const states: RemoteHostBrokerState[] = [];
  const broker = revocation(memory, states, { keys: [], creations: [], hosts: [], bindings: [], journalDeletions: ['gone-1', 'gone-2', 'gone-3'] });
  try {
    await sleep(50);
    expect(await memory.catalog.list('')).toEqual([]);
    expect(states.at(-1)).not.toHaveProperty('journalDeletions');
  } finally { broker.close(); }
});

it('retries a pending deletion that failed at start when a Host registers', async () => {
  let calls = 0;
  const saved: RemoteHostBrokerState[] = [];
  const r = await relay({ state: state => ({ ...state, journalDeletions: ['gone'] }), seed: store => goneJournal(store, 'gone'),
    broker: { onStateChange: async state => { saved.push(structuredClone(state)); } },
    journalStore: store => storeDeleting(store, () => (calls++ === 0 ? 'fail' : 'delete')) });
  await sleep(30);
  expect(await r.store.catalog.list('gone:')).toHaveLength(1);
  await r.connectController();
  await sleep(50);
  expect(await r.store.catalog.list('gone:')).toEqual([]);
  expect(saved.at(-1)).not.toHaveProperty('journalDeletions');
});

it('registers a returning Host without journals while its own deletion has not been confirmed, and grants them once it has', async () => {
  const failing = await relay({ state: state => ({ ...state, journalDeletions: [HOST_ID] }), seed: store => seedJournal(store),
    journalStore: memory => storeDeleting(memory, () => 'fail') });
  const refused = await failing.connectController();
  expect(registeredOf(refused)).not.toHaveProperty('journal');
  const confirmed = await relay({ state: state => ({ ...state, journalDeletions: [HOST_ID] }), seed: store => seedJournal(store) });
  expect(registeredOf(await confirmed.connectController())).toMatchObject({ journal: 1 });
});

it('waits only for its own deletion before registering a returning Host, not for the other pending Hosts', async () => {
  let release!: () => void;
  const own = new Promise<void>(resolve => { release = resolve; });
  const r = await relay({ state: state => ({ ...state, journalDeletions: ['other', HOST_ID] }), seed: async store => { await seedJournal(store); await goneJournal(store, 'other'); },
    broker: { journalDeletionWaitMs: 3000 },
    journalStore: memory => ({ load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
      catalog: { list: prefix => memory.catalog.list(prefix), deletePrefix: async prefix => {
        if (prefix.startsWith('other:')) return new Promise<void>(() => undefined);
        await own;
        await memory.catalog.deletePrefix(prefix);
      } } }) });
  let registered = false;
  const connecting = r.connectController().then(controller => { registered = true; return controller; });
  await sleep(100);
  expect(registered).toBe(false);
  release();
  await sleep(300);
  expect(registered).toBe(true);
  expect(registeredOf(await connecting)).toMatchObject({ journal: 1 });
});

it('tells a returning Host it is registered once, even when its deletion finishes after the deadline', async () => {
  let release!: () => void;
  const late = new Promise<void>(resolve => { release = resolve; });
  const r = await relay({ state: state => ({ ...state, journalDeletions: [HOST_ID] }), seed: store => seedJournal(store),
    broker: { journalDeletionWaitMs: 50 },
    journalStore: memory => ({ load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
      catalog: { list: prefix => memory.catalog.list(prefix), deletePrefix: async prefix => { await late; await memory.catalog.deletePrefix(prefix); } } }) });
  const controller = await r.connectController();
  release();
  await sleep(100);
  expect(controller.inbox.all.filter(message => message.type === 'registered')).toHaveLength(1);
});

it('registers a returning Host without journals after the deadline when the store never answers, and keeps the deletion pending', async () => {
  const saved: RemoteHostBrokerState[] = [];
  const r = await relay({ state: state => ({ ...state, journalDeletions: [HOST_ID] }), seed: store => seedJournal(store),
    broker: { journalDeletionWaitMs: 100, onStateChange: async state => { saved.push(structuredClone(state)); } },
    journalStore: memory => storeDeleting(memory, () => 'hang') });
  const started = Date.now();
  const controller = await r.connectController();
  expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  expect(registeredOf(controller)).not.toHaveProperty('journal');
  expect(saved.at(-1)?.journalDeletions ?? [HOST_ID]).toEqual([HOST_ID]);
});

it('deletes the journals of a pending Host once, however many asks share the run', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prefixes: string[] = [];
  const r = await relay({ state: state => ({ ...state, journalDeletions: [HOST_ID] }), seed: store => seedJournal(store),
    broker: { journalDeletionWaitMs: 3000 },
    journalStore: memory => ({ load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
      catalog: { list: prefix => memory.catalog.list(prefix), deletePrefix: async prefix => { prefixes.push(prefix); await gate; await memory.catalog.deletePrefix(prefix); } } }) });
  const connecting = r.connectController();
  await sleep(60);
  release();
  await connecting;
  await sleep(50);
  expect(prefixes).toEqual([`${HOST_ID}:`]);
});

it('does not hold a returning Host back for its pending deletion when its Controller asked for no journals', async () => {
  const r = await relay({ state: state => ({ ...state, journalDeletions: [HOST_ID] }), seed: store => seedJournal(store),
    broker: { journalDeletionWaitMs: 3000 }, journalStore: memory => storeDeleting(memory, () => 'hang') });
  const started = Date.now();
  const controller = await r.connectController({ journal: false });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(registeredOf(controller)).not.toHaveProperty('journal');
});

/** A store that counts how many deletions run at once, overall and per Host, and which Hosts it was asked to delete. */
function countingStore(memory: MemoryJournalStore, decide: (prefix: string, call: number) => Promise<void>) {
  const calls: string[] = [];
  const state = { running: 0, peak: 0, duplicate: false };
  const active = new Set<string>();
  const store: JournalStore = { load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
    catalog: { list: prefix => memory.catalog.list(prefix), deletePrefix: async prefix => {
      if (active.has(prefix)) state.duplicate = true;
      active.add(prefix); calls.push(prefix);
      state.running += 1; state.peak = Math.max(state.peak, state.running);
      try { await decide(prefix, calls.length); await memory.catalog.deletePrefix(prefix); }
      finally { state.running -= 1; active.delete(prefix); }
    } } };
  return { store, calls, state };
}

it('deletes pending Hosts four at a time, and confirmations that wait for a commit share the next one', async () => {
  const ids = Array.from({ length: 40 }, (_, at) => `gone-${at}`);
  const { store, state } = countingStore(new MemoryJournalStore(), () => sleep(5));
  const states: RemoteHostBrokerState[] = [];
  const broker = createHostBroker({ origin: 'https://relay.example', accountBacked: true, journals: store, now: () => 10_000,
    onStateChange: async next => { await sleep(20); states.push(structuredClone(next)); },
    initialState: { keys: [], creations: [], hosts: [], bindings: [], journalDeletions: ids } });
  try {
    await sleep(900);
    expect(state.peak).toBe(4);
    expect(states.at(-1)).not.toHaveProperty('journalDeletions');
    expect(states.length).toBeLessThan(ids.length);
  } finally { broker.close(); }
});

it('deletes the other pending Hosts and keeps the one whose store call never answers', async () => {
  const ids = Array.from({ length: 10 }, (_, at) => `gone-${at}`);
  const memory = new MemoryJournalStore();
  for (const id of ids) await goneJournal(memory, id);
  const { store } = countingStore(memory, prefix => (prefix === 'gone-0:' ? new Promise<void>(() => undefined) : Promise.resolve()));
  const states: RemoteHostBrokerState[] = [];
  const broker = revocation(store, states, { keys: [], creations: [], hosts: [], bindings: [], journalDeletions: ids });
  try {
    await sleep(100);
    expect(await memory.catalog.list('')).toEqual([expect.objectContaining({ sessionKey: 'gone-0:codex:native-session' })]);
    expect(states.at(-1)!.journalDeletions).toEqual(['gone-0']);
  } finally { broker.close(); }
});

it('does not let a deletion that began before a re-revoke clear the new revoke', async () => {
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const { store, calls } = countingStore(new MemoryJournalStore(), (_prefix, call) => (call === 1 ? first : new Promise<void>(() => undefined)));
  const states: RemoteHostBrokerState[] = [];
  const broker = revocation(store, states, { keys: [], creations: [], journalDeletions: [HOST_ID],
    hosts: [{ id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }],
    bindings: [{ hostId: HOST_ID, providerId: 'codex', nativeSessionId: 'native-session', agentId: PUBLIC_ID }] });
  try {
    await sleep(20);
    expect(calls).toHaveLength(1);
    expect((await revoke(broker))!.status).toBe(200);
    release();
    await sleep(60);
    expect(calls).toHaveLength(2);
    expect(states.at(-1)!.journalDeletions).toEqual([HOST_ID]);
  } finally { broker.close(); }
});

it('never runs more than four store deletions or deletes one Host twice at once, across overlapping revokes and registrations', async () => {
  const ids = Array.from({ length: 12 }, (_, at) => `gone-${at}`);
  const memory = new MemoryJournalStore();
  const { store, state } = countingStore(memory, () => sleep(15));
  const states: RemoteHostBrokerState[] = [];
  const broker = revocation(store, states, { keys: [], creations: [], bindings: [], journalDeletions: [...ids, HOST_ID],
    hosts: [{ id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false },
      { id: 'host-2', installationId: 'second-installation', name: 'Second Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }] });
  try {
    await sleep(10);
    await revoke(broker);
    await broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/host-2/revoke', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://relay.example' }, body: '{}' }), {});
    await sleep(400);
    expect(state.peak).toBeLessThanOrEqual(4);
    expect(state.duplicate).toBe(false);
    expect(states.at(-1)).not.toHaveProperty('journalDeletions');
  } finally { broker.close(); }
});

it('deletes a Host revoked later while another Host\'s deletion still hangs', async () => {
  const memory = new MemoryJournalStore();
  await goneJournal(memory, 'gone-0');
  await seedJournal(memory);
  const states: RemoteHostBrokerState[] = [];
  const broker = revocation(storeDeleting(memory, prefix => (prefix === 'gone-0:' ? 'hang' : 'delete')), states, { keys: [], creations: [], journalDeletions: ['gone-0'],
    hosts: [{ id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }],
    bindings: [{ hostId: HOST_ID, providerId: 'codex', nativeSessionId: 'native-session', agentId: PUBLIC_ID }] });
  try {
    await sleep(30);
    expect((await revoke(broker))!.status).toBe(200);
    await sleep(60);
    expect(await memory.catalog.list(`${HOST_ID}:`)).toEqual([]);
    expect(states.at(-1)!.journalDeletions).toEqual(['gone-0']);
  } finally { broker.close(); }
});

it('asks the journal service for at most four deletions at once from one broker, however many revokes and registrations come', async () => {
  const ids = Array.from({ length: 12 }, (_, at) => `gone-${at}`);
  let running = 0, peak = 0;
  const asked: string[] = [];
  const journalService = { deleteHost: async (hostId: string) => {
    asked.push(hostId); running += 1; peak = Math.max(peak, running);
    await sleep(15);
    running -= 1;
  } } as unknown as NonNullable<Parameters<typeof createHostBroker>[0]['journalService']>;
  const states: RemoteHostBrokerState[] = [];
  const broker = createHostBroker({ origin: 'https://relay.example', accountBacked: true, journalService, now: () => 10_000,
    onStateChange: async state => { states.push(structuredClone(state)); },
    initialState: { keys: [], creations: [], bindings: [], journalDeletions: ids,
      hosts: [{ id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false },
        { id: 'host-2', installationId: 'second-installation', name: 'Second Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }] } });
  try {
    await sleep(5);
    await revoke(broker);
    await broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/host-2/revoke', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://relay.example' }, body: '{}' }), {});
    await sleep(300);
    expect(peak).toBe(4);
    expect(asked.sort()).toEqual([...ids, 'host-2', HOST_ID].sort());
    expect(states.at(-1)).not.toHaveProperty('journalDeletions');
  } finally { broker.close(); }
});
