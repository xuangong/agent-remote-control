import { expect, it } from 'vitest';
import { fixture, origin, send } from './fixture.js';

// One Worker test per Relay feature that keeps records: the rules are the Relay's and run in agent-relay-core
// (gateway-*.test.ts); these prove that the feature reaches the Durable Object SQLite storage and comes back after the Worker restarts.

type Fixture = Awaited<ReturnType<typeof fixture>>;
const ref = (hostId: string, nativeSessionId = 'thread') => ({ hostId, providerId: 'codex', nativeSessionId });
async function pairedHost(f: Fixture, account: Awaited<ReturnType<Fixture['login']>>, ...features: Parameters<Fixture['host']> extends [string, ...infer Rest] ? Rest : never) {
  const { key } = await (await f.json(account.basePath + 'v1/remote/pairings', account.cookie, {})).json() as { key: string };
  return f.host(key, ...features);
}
/** Answers every native request of the Host with the identity the Relay asked about. */
function answerNative(host: { socket: any }, answer: (frame: any, input: any) => object = () => ({})) {
  host.socket.addEventListener('message', (message: { data: unknown }) => {
    const frame = JSON.parse(String(message.data)); if (frame.type !== 'rpc_request') return;
    const input = JSON.parse(frame.body ?? '{}');
    send(host.socket, { type: 'rpc_response', requestId: frame.requestId, status: 200, body: JSON.stringify({ agentId: frame.sessionId, nativeSessionId: input.nativeSessionId, ...answer(frame, input) }) });
  });
}

type Account = Awaited<ReturnType<Fixture['login']>>;
/** One feature: `keep` stores its records before the Worker restarts; `restore` checks them with the account signed in again afterwards. */
interface Feature { name: string; keep(f: Fixture, account: Account): Promise<(f: Fixture, again: Account) => Promise<void>> }

const features: Feature[] = [
  { name: 'drafts', async keep(f, alice) {
    const saved = await (await f.json(alice.basePath + 'v1/session-drafts', alice.cookie, { ...ref('host'), text: 'After the restart' })).json();
    return async (f, again) => { expect(await (await f.json(again.basePath + 'v1/session-drafts', again.cookie)).json()).toEqual({ drafts: [saved] }); };
  } },
  { name: 'read positions', async keep(f, alice) {
    const position = { ...ref('host'), readAt: 7 };
    const started = await (await f.json(alice.basePath + 'v1/session-reads', alice.cookie, { reads: [position] })).json() as { since: number };
    return async (f, again) => { expect(await (await f.json(again.basePath + 'v1/session-reads', again.cookie)).json()).toEqual({ since: started.since, reads: [position] }); };
  } },
  { name: 'stars', async keep(f, alice) {
    const host = await pairedHost(f, alice); answerNative(host);
    const star = { ...ref(host.hostId, 'native-one'), title: 'First conversation' };
    expect((await f.json(alice.basePath + 'v1/stars', alice.cookie, star)).status).toBe(200);
    return async (f, again) => {
      expect((await (await f.json(again.basePath + 'v1/stars', again.cookie)).json() as { stars: unknown[] }).stars).toEqual([expect.objectContaining(star)]);
      const headers = { cookie: again.cookie, origin, 'content-type': 'application/json' };
      expect((await f.request(again.basePath + 'v1/stars', { method: 'DELETE', headers, body: JSON.stringify(ref(host.hostId, 'native-one')) })).status).toBe(200);
      expect(await (await f.json(again.basePath + 'v1/stars', again.cookie)).json()).toEqual({ stars: [] });
    };
  } },
  { name: 'the favorites tree', async keep(f, alice) {
    expect((await f.json(alice.basePath + 'v1/favorites', alice.cookie, { type: 'create-folder', id: 'folder', parentId: null, title: 'Work', revision: 0 })).status).toBe(200);
    return async (f, again) => { expect(await (await f.json(again.basePath + 'v1/favorites', again.cookie)).json()).toMatchObject({ revision: 1, folders: [{ id: 'folder', title: 'Work' }] }); };
  } },
  { name: 'a session title', async keep(f, alice) {
    const host = await pairedHost(f, alice, false, undefined, true); answerNative(host, (_frame, input) => ({ title: input.title }));
    const identity = ref(host.hostId, 'unstarred');
    expect((await f.json(alice.basePath + `v1/remote/hosts/${host.hostId}/session/rename`, alice.cookie, { providerId: 'codex', nativeSessionId: 'unstarred', title: 'Main session', operationId: 'new-title' })).status).toBe(200);
    return async (f, again) => {
      const messages: any[] = [];
      const socket = await f.upgrade(again.basePath + 'v1/session-channel?observation=session&titles=1', { cookie: again.cookie, origin });
      socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
      await expect.poll(() => messages.find(message => message.type === 'session_title_updated')?.session).toMatchObject({ ...identity, title: 'Main session' });
    };
  } },
  { name: 'Side relations and an unlink', async keep(f, alice) {
    const host = await pairedHost(f, alice); answerNative(host, (frame, input) => ({ nativeSessionId: frame.path === '/remote/create' ? input.operationId : input.nativeSessionId }));
    const route = alice.basePath + `v1/remote/hosts/${host.hostId}/create`;
    await f.json(route, alice.cookie, { providerId: 'codex', operationId: 'main' });
    await f.json(route, alice.cookie, { providerId: 'codex', operationId: 'side', sourceNativeSessionId: 'main', conversationKind: 'side' });
    const relations = async (account: Account) => (await (await f.json(account.basePath + 'v1/session-relations', account.cookie)).json() as { relations: any[] }).relations;
    const relation = (await relations(alice))[0]!;
    const unlinked = await f.json(alice.basePath + 'v1/session-relations', alice.cookie, { hostId: host.hostId, providerId: 'codex', nativeSessionId: relation.target.nativeSessionId,
      sourceNativeSessionId: relation.source.nativeSessionId, id: relation.id, linked: false, expectedRevision: 0 }, 'PATCH');
    expect(unlinked.status).toBe(200);
    return async (f, again) => { expect(await relations(again)).toEqual([expect.objectContaining({ id: 'side', linked: false, revision: 1 })]); };
  } },
  { name: 'a prompt fork migration', async keep(f, alice) {
    const host = await pairedHost(f, alice, true);
    answerNative(host, (frame, input) => ({ nativeSessionId: frame.path === '/remote/create' ? 'new' : input.nativeSessionId }));
    const path = alice.basePath + `v1/remote/hosts/${host.hostId}/`;
    expect((await f.json(path + 'attach', alice.cookie, { providerId: 'codex', nativeSessionId: 'old' })).status).toBe(200);
    expect((await f.json(path + 'create', alice.cookie, { providerId: 'codex', operationId: 'edit-1', editNativeSessionId: 'old', editTurnId: 'turn', editMessageId: 'message' })).status).toBe(200);
    return async (f, again) => { expect(await (await f.json(again.basePath + 'v1/session-migrations', again.cookie)).json()).toMatchObject({ migrations: [{ id: 'edit-1' }] }); };
  } },
  { name: 'a message waiting for an offline Host', async keep(f, alice) {
    const { key } = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
    const socket = await f.upgrade('/ws/remote-host?outbox=1', { authorization: `Bearer ${key}` });
    const frames: any[] = [];
    socket.addEventListener('message', event => {
      const frame = JSON.parse(String(event.data)); frames.push(frame);
      if (frame.type === 'credential_issued') send(socket, { type: 'credential_saved' });
    });
    send(socket, { type: 'register', credentialRotation: true, installationId: 'workers-host', name: 'Workers Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] });
    await expect.poll(() => frames.find(frame => frame.type === 'registered')?.outbox).toBe(1);
    const hostId = frames.find(frame => frame.type === 'registered').hostId as string;
    socket.close();
    const id = '00000000-0000-4000-8000-000000000001';
    expect((await f.json(alice.basePath + 'v1/outbox', alice.cookie, { id, ...ref(hostId), text: 'Run the suite when you are back.' })).status).toBe(200);
    return async (f, again) => { expect(await (await f.json(again.basePath + 'v1/outbox', again.cookie)).json()).toEqual({ entries: [expect.objectContaining({ id, status: 'waiting' })] }); };
  } },
];

it('every feature that keeps records comes back from the Durable Object storage after the Worker restarts', async () => {
  const f = await fixture();
  const accounts = new Map<Feature, Account>(), checks = new Map<Feature, (f: Fixture, again: Account) => Promise<void>>();
  for (const [index, feature] of features.entries()) {
    const account = await f.login(`feature-${index}`);
    accounts.set(feature, account); checks.set(feature, await feature.keep(f, account));
  }
  await f.restart();
  for (const [index, feature] of features.entries()) await checks.get(feature)!(f, await f.login(`feature-${index}`));
});

it('session states reach a page over a Worker session channel', async () => {
  const f = await fixture(); const alice = await f.login('alice');
  const { key } = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const host = await f.upgrade('/ws/remote-host?sessionStates=1', { authorization: `Bearer ${key}` });
  host.addEventListener('message', event => { const frame = JSON.parse(String(event.data)); if (frame.type === 'credential_issued') send(host, { type: 'credential_saved' }); });
  send(host, { type: 'register', credentialRotation: true, installationId: 'workers-host', name: 'Workers Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] });
  const messages: any[] = [];
  const page = await f.upgrade(alice.basePath + 'v1/session-channel?observation=activity&states=1', { cookie: alice.cookie, origin });
  page.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
  await expect.poll(() => messages.find(message => message.type === 'session_states')).toMatchObject({ snapshot: true });
  await expect.poll(() => messages.some(message => message.type === 'session_states' && message.hosts?.[0]?.online)).toBe(true);
  send(host, { type: 'session_states', full: true, states: [{ providerId: 'codex', nativeSessionId: 'thread', state: 'running', updatedAt: 5 }] });
  await expect.poll(() => messages.filter(message => message.type === 'session_states').at(-1)?.states?.[0]).toMatchObject({ nativeSessionId: 'thread', state: 'running' });
});
