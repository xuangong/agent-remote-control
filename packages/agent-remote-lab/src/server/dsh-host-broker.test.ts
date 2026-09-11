// @vitest-environment node
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient } from '@borgee/agent-remote-web/headless';
import { startDshAgentRemote } from '../../../agent-remote-dsh/src/agent-remote.js';
import { createRemoteHostBroker } from './remote-host-broker.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 30_000);

/** Native service fixture; the broker, plugin, uplink, Relay and browser client are production implementations. */
function nativeServices() {
  type NativeEvent = { type: string; seq: number; time: number; data: unknown };
  type NativeAgent = {
    id: string; status: 'idle'; options: {};
    session: { id: string; header: { id: string; createdAt: number; cwd: string; origin?: string; parentSession?: string };
      snapshotEvents(): NativeEvent[]; requestHeader(): undefined };
    followup(message: unknown): void; steer(): void; cancel(): void;
  };
  const agents = new Map<string, NativeAgent>();
  const histories = new Map<string, NativeEvent[]>();
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const inputs: Array<{ id: string; message: unknown }> = [];
  const creations: Array<{ sessionId: string; workspaceId?: string }> = [];
  let releasedCuts = 0;
  const add = (id: string, parentSession?: string) => {
    histories.set(id, []);
    const agent: NativeAgent = {
      id, status: 'idle', options: {},
      session: { id, header: { id, createdAt: 100, cwd: '/fixture/workspace', ...(parentSession ? { origin: 'subagent', parentSession } : {}) },
        snapshotEvents: () => [...histories.get(id)!], requestHeader: () => undefined },
      followup: (message) => { inputs.push({ id, message }); }, steer() {}, cancel() {},
    };
    agents.set(id, agent); return agent;
  };
  const append = (id: string, type: string, data: unknown) => {
    const events = histories.get(id)!;
    const event = { type, data, seq: events.length, time: 101 + events.length };
    events.push(event);
    for (const listener of listeners.get('session/event') ?? []) listener(agents.get(id)!.session, event);
  };
  const context = {
    get: (name: string) => name === 'tools' ? { get: () => undefined, schemas: () => [] } : undefined,
    on(name: string, listener: (...args: any[]) => void) {
      const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set);
      return () => set.delete(listener);
    },
    agents: { roots: () => [...agents.values()], get: (id: string) => agents.get(id) },
    sessions: { flush: async () => {} },
    subagents: { listChildren: async (parentId: string) => [...agents.values()]
      .filter(({ session }) => session.header.parentSession === parentId)
      .map(({ id }) => ({ kind: 'child', id, mode: 'continuable', label: 'Research child' })) },
    sessionQuery: {
      listSessions: async () => [],
      async observeSession(id: string) {
        const agent = agents.get(id); if (!agent) throw new Error('Native session missing');
        return { header: agent.session.header, source: 'live', events: agent.session.snapshotEvents(), inheritedEventCount: 0,
          projections: { values: { subagent: { mode: 'continuable', seq: 0 } } }, [Symbol.dispose]() { releasedCuts++; } };
      },
    },
    sessionController: {
      async resolveAgent(id: string) { return agents.has(id) ? { agent: agents.get(id)! } : { error: { code: 'session/not-found' } }; },
      async create(request: { sessionId: string; workspaceId?: string }) { creations.push(request); add(request.sessionId); return { sessionId: request.sessionId }; },
      async modelCatalog() { return { default: { provider: 'fixture', model: 'model-a' }, routableProviders: ['fixture'], failures: [], groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'model-a', name: 'Model A' }] }] }; },
    },
    workspaceRegistry: { list: () => [{ id: 'workspace', title: 'Fixture workspace', path: '/fixture/workspace' }] },
  };
  return { context, add, append, agents, inputs, creations, releasedCuts: () => releasedCuts };
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-host-broker-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  cleanup.push(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  const server = createServer((_, response) => { response.statusCode = 404; response.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const broker = createRemoteHostBroker({ origin: url, rpcTimeoutMs: 3000 });
  broker.install(server);
  cleanup.push(async () => { await broker.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const get = (path: string) => fetch(url + path, { signal: AbortSignal.timeout(3000) });
  const post = (path: string, body = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  const native = nativeServices();
  native.add('parent'); native.add('child', 'parent');
  native.append('child', 'subagent/descriptor', {});
  native.append('child', 'user/message', { id: 'child-input', source: { kind: 'user' }, content: [{ type: 'text', text: 'Child history' }] });
  const connect = async () => {
    const pairing = await (await post('/v1/remote/pairings')).json();
    const host = await startDshAgentRemote(native.context as never, { serverUrl: url, remoteKey: pairing.key, instanceName: 'DSH integration fixture' });
    cleanup.push(() => host.close()); await host.ready; return host;
  };
  const host = await connect();
  const transport = new HttpWebSocketTransport(url, { webSocketFactory: (address) => new WebSocket(address, { headers: { origin: url } }) as never });
  const client = async (agentId: string) => {
    const replica = new AgentReplica();
    const session = new RemoteSessionClient(agentId, transport, replica, { operationTimeoutMs: 3000 });
    let status = ''; session.subscribeStatus((next) => { status = next; });
    cleanup.push(async () => session.stop()); session.start();
    await vi.waitFor(() => expect(status).toBe('ready'), { timeout: 3000 });
    return { session, replica };
  };
  return { native, host, connect, get, post, transport, client };
}

it('registers DSH directories and preserves canonical parent/readonly-child bindings after re-pairing', async () => {
  const f = await setup();
  const listed = await (await f.get('/v1/remote/hosts')).json();
  expect(listed.hosts).toEqual([expect.objectContaining({ online: true, providers: [{ providerId: 'dsh', displayName: 'DeepSeek Harness' }] })]);
  const hostId = listed.hosts[0].id;
  const base = `/v1/remote/hosts/${hostId}`;
  const catalog = await (await f.get(base + '/catalog?providerId=dsh')).json();
  expect(catalog.items.map((item: { nativeSessionId: string }) => item.nativeSessionId)).toEqual(['parent']);
  expect(await (await f.get(base + '/models?providerId=dsh')).json()).toMatchObject({ groups: [{ id: 'fixture', models: [{ id: 'model-a' }] }] });
  expect(await (await f.get(base + '/workspaces?providerId=dsh')).json()).toEqual({ workspaces: [{ id: 'workspace', name: 'Fixture workspace', path: '/fixture/workspace' }] });
  expect((await f.get(base + '/catalog?providerId=foreign')).status).toBe(400);
  expect((await f.get(base + '/catalog')).status).toBe(400);

  const parentResponse = await f.post(base + '/attach', { providerId: 'dsh', nativeSessionId: 'parent' });
  expect(parentResponse.status).toBe(200);
  const parent = await parentResponse.json();
  const parentSnapshot = await f.transport.fetchSnapshot(parent.agentId);
  expect(parentSnapshot.payload.runtimeInfo?.childSessions).toMatchObject([{ nativeSessionId: 'child', title: 'Research child' }]);
  const parentClient = await f.client(parent.agentId);
  expect((await parentClient.session.sendMessage('Parent remains writable')).type).toBe('command_acknowledged');
  expect(f.native.inputs).toEqual([{ id: 'parent', message: expect.objectContaining({ content: [{ type: 'text', text: 'Parent remains writable' }] }) }]);

  const childBody = { providerId: 'dsh', parentNativeSessionId: 'parent', nativeSessionId: 'child' };
  const childResponse = await f.post(base + '/child/attach', childBody);
  expect(childResponse.status).toBe(200);
  const child = await childResponse.json();
  expect((await f.transport.fetchSnapshot(child.agentId)).payload.capabilities).toMatchObject({ sendMessage: false, cancel: false, steer: false, commands: false, sessionSettings: false });
  const childClient = await f.client(child.agentId);
  await vi.waitFor(() => expect(JSON.stringify(childClient.replica.getState().timeline)).toContain('Child history'), { timeout: 3000 });
  await expect(childClient.session.sendMessage('Forbidden child input')).rejects.toMatchObject({ code: 'unsupported_command' });
  expect(f.native.inputs).toHaveLength(1);
  f.native.append('child', 'user/message', { id: 'child-live', source: { kind: 'user' }, content: [{ type: 'text', text: 'Live child output' }] });
  await vi.waitFor(() => expect(JSON.stringify(childClient.replica.getState().timeline)).toContain('Live child output'), { timeout: 3000 });
  expect((await f.post(base + '/child/attach', { ...childBody, parentNativeSessionId: 'foreign' })).status).toBe(409);
  expect((await f.post(base + '/attach', { providerId: 'dsh', nativeSessionId: 'child' })).status).toBe(409);

  parentClient.session.stop(); childClient.session.stop();
  await f.host.close();
  expect(f.native.agents.has('parent')).toBe(true); expect(f.native.agents.has('child')).toBe(true);
  await f.connect();
  expect(await (await f.get('/v1/remote/hosts')).json()).toMatchObject({ hosts: [{ id: hostId, online: true }] });
  expect((await f.transport.fetchSnapshot(child.agentId)).payload.id).toBe(child.agentId);
  expect(await (await f.post(base + '/attach', { providerId: 'dsh', nativeSessionId: 'parent' })).json()).toEqual(parent);
  expect(await (await f.post(base + '/child/attach', childBody)).json()).toEqual(child);
  const recovered = await f.client(child.agentId);
  await vi.waitFor(() => expect(JSON.stringify(recovered.replica.getState().timeline)).toContain('Live child output'), { timeout: 3000 });
  expect(f.native.creations).toEqual([]);
  expect(f.native.releasedCuts()).toBeGreaterThan(0);
}, 10_000);

it('uses modern create request identity for concurrent retries and rejects configuration conflicts', async () => {
  const f = await setup();
  const { hosts } = await (await f.get('/v1/remote/hosts')).json();
  const base = `/v1/remote/hosts/${hosts[0].id}`;
  const body = { providerId: 'dsh', requestId: 'create-once', workspaceId: 'workspace' };
  const responses = await Promise.all([f.post(base + '/create', body), f.post(base + '/create', body)]);
  expect(responses.map(({ status }) => status)).toEqual([200, 200]);
  const [first, retry] = await Promise.all(responses.map((response) => response.json()));
  expect(retry).toEqual(first);
  expect(first).toEqual({ agentId: expect.any(String), nativeSessionId: expect.any(String) });
  expect(f.native.creations).toEqual([{ sessionId: first.nativeSessionId, workspaceId: 'workspace' }]);
  expect((await f.post(base + '/create', { ...body, workspaceId: 'different' })).status).toBe(409);
  expect((await f.post(base + '/create', { providerId: 'dsh' })).status).toBe(400);
  expect((await f.post(base + '/create', { ...body, requestId: 'override', reasoningEffort: 'high' })).status).toBe(400);
  expect(f.native.creations).toHaveLength(1);
  const catalog = await (await f.get(base + '/catalog?providerId=dsh')).json();
  expect(catalog.items).toContainEqual(expect.objectContaining({ nativeSessionId: first.nativeSessionId, providerId: 'dsh' }));
  await f.host.close(); await f.connect();
  expect(await (await f.post(base + '/create', body)).json()).toEqual(first);
  expect((await f.transport.fetchSnapshot(first.agentId)).payload.id).toBe(first.agentId);
  expect(f.native.creations).toHaveLength(1);
}, 10_000);
