import { WebSocketServer, type WebSocket } from 'ws';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply as applyAgentRemote, startDshAgentRemote, type Config } from './agent-remote.js';

const closeables: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closeables.splice(0).reverse()) await close(); });

function setRemoteInstanceName(value: string | undefined): void {
  const previous = process.env.AGENT_REMOTE_INSTANCE_NAME;
  if (value === undefined) delete process.env.AGENT_REMOTE_INSTANCE_NAME;
  else process.env.AGENT_REMOTE_INSTANCE_NAME = value;
  closeables.push(async () => {
    if (previous === undefined) delete process.env.AGENT_REMOTE_INSTANCE_NAME;
    else process.env.AGENT_REMOTE_INSTANCE_NAME = previous;
  });
}

class FrameQueue implements AsyncIterable<unknown> {
  private readonly frames: unknown[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(frame: unknown): void {
    this.frames.push(frame);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    while (true) {
      if (this.frames.length > 0) { yield this.frames.shift(); continue; }
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

async function startRemoteHost(native: ReturnType<typeof remoteNativeHost>, overrides: Config = {}) {
  const broker = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => broker.once('listening', resolve));
  closeables.push(() => new Promise<void>((resolve) => {
    for (const socket of broker.clients) socket.terminate();
    broker.close(() => resolve());
  }));
  const sockets: WebSocket[] = [], credentials: string[] = [], registrations: unknown[] = [];
  const streamFrames = new Map<string, Array<Record<string, unknown>>>();
  const pending = new Map<string, (response: Response) => void>();
  let sequence = 0;
  broker.on('connection', (socket, request) => {
    sockets.push(socket);
    credentials.push(request.headers.authorization ?? '');
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'register') {
        registrations.push(message);
        socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host-one' }));
      }
      if (message.type === 'rpc_response') {
        pending.get(message.requestId)?.(new Response(message.body, { status: message.status }));
        pending.delete(message.requestId);
      }
      if (typeof message.streamId === 'string') {
        const frames = streamFrames.get(message.streamId) ?? [];
        frames.push(message.type === 'stream_message'
          ? JSON.parse(message.message) as Record<string, unknown>
          : message as Record<string, unknown>);
        streamFrames.set(message.streamId, frames);
      }
    });
  });
  const identityHome = await mkdtemp(join(tmpdir(), 'agent-remote-control-identity-'));
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = identityHome;
  closeables.push(async () => {
    if (priorHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorHome;
    await rm(identityHome, { recursive: true, force: true });
  });
  const address = broker.address() as { port: number };
  const host = await startDshAgentRemote(native.context as never, {
    serverUrl: `http://127.0.0.1:${address.port}`, remoteKey: 'remote-test-key', instanceName: 'Test DSH', ...overrides,
  });
  closeables.push(host.close);
  await host.ready;
  const request = (path: string, sessionId?: string, body?: string) => new Promise<Response>((resolve, reject) => {
    const requestId = `remote-rpc-${++sequence}`;
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`Remote RPC fixture timed out for ${path}.`)); }, 3000);
    pending.set(requestId, (response) => { clearTimeout(timeout); resolve(response); });
    sockets.at(-1)!.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId,
      method: body === undefined ? 'GET' : 'POST', path, ...(sessionId === undefined ? {} : { sessionId }), ...(body === undefined ? {} : { body }),
    }));
  });
  const openStream = (streamId: string, sessionId: string) => sockets.at(-1)!.send(JSON.stringify({
    uplinkVersion: 2, type: 'stream_open', streamId, sessionId,
  }));
  const sendStream = (streamId: string, message: Record<string, unknown>) => sockets.at(-1)!.send(JSON.stringify({
    uplinkVersion: 2, type: 'stream_message', streamId, message: JSON.stringify(message),
  }));
  return { host, sockets, credentials, registrations, request, identityHome, openStream, sendStream,
    streamFrames: (streamId: string) => streamFrames.get(streamId) ?? [] };
}

describe('DSH Remote Host plugin', () => {
  it('hot-replaces the Remote Host without recreating its native interaction adapter', async () => {
    const native = remoteNativeHost();
    const broker = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => broker.once('listening', resolve));
    closeables.push(() => new Promise<void>((resolve) => {
      for (const socket of broker.clients) socket.terminate();
      broker.close(() => resolve());
    }));
    const registrations: Array<{ name: string }> = [];
    broker.on('connection', (socket) => socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as { type?: string; name?: string };
      if (message.type !== 'register') return;
      registrations.push({ name: message.name ?? '' });
      socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: `host-${registrations.length}` }));
    }));
    const identityHome = await mkdtemp(join(tmpdir(), 'agent-remote-control-apply-'));
    const priorHome = process.env.DSH_HOME;
    process.env.DSH_HOME = identityHome;
    closeables.push(async () => {
      if (priorHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = priorHome;
      await rm(identityHome, { recursive: true, force: true });
    });
    let watch: ((next: { serverUrl: string; remoteKey: string; instanceName: string }) => void | Promise<void>) | undefined;
    const settings = {
      register: vi.fn(() => ({
        get: () => ({ serverUrl: '', remoteKey: '', instanceName: 'Test DSH' }),
        watch: (listener: typeof watch) => { watch = listener; return () => { watch = undefined; }; },
      })),
    };
    let dispose: (() => Promise<void>) | undefined;
    const context = Object.assign(native.context, {
      settings,
      effect: async (install: () => Promise<() => Promise<void>>) => { dispose = await install(); },
    });

    await applyAgentRemote(context as never);
    expect(registrations).toEqual([]);
    expect(native.listenerCount('user-questions/request')).toBe(1);
    expect(native.listenerCount('approval/request')).toBe(1);

    const address = broker.address() as { port: number };
    await watch?.({ serverUrl: `http://127.0.0.1:${address.port}`, remoteKey: 'first-key', instanceName: 'First DSH' });
    await vi.waitFor(() => expect(registrations).toEqual([{ name: 'First DSH' }]), { timeout: 3000 });
    expect(native.listenerCount('agent/disposed')).toBe(1);

    await watch?.({ serverUrl: `http://127.0.0.1:${address.port}`, remoteKey: 'second-key', instanceName: 'Second DSH' });
    await vi.waitFor(() => expect(registrations).toEqual([{ name: 'First DSH' }, { name: 'Second DSH' }]), { timeout: 3000 });
    expect(native.listenerCount('user-questions/request')).toBe(1);
    expect(native.listenerCount('approval/request')).toBe(1);
    expect(native.listenerCount('agent/disposed')).toBe(1);

    await watch?.({ serverUrl: `http://127.0.0.1:${address.port}`, remoteKey: '', instanceName: 'Second DSH' });
    await vi.waitFor(() => expect(native.listenerCount('agent/disposed')).toBe(0), { timeout: 3000 });
    await dispose?.();
    expect(native.listenerCount('user-questions/request')).toBe(0);
    expect(native.listenerCount('approval/request')).toBe(0);
  });

  it('uses a configured Remote Host instance name before its environment value', async () => {
    setRemoteInstanceName('Environment DSH');
    const remote = await startRemoteHost(remoteNativeHost(), { instanceName: 'Configured DSH' });
    expect(remote.registrations).toEqual([expect.objectContaining({ name: 'Configured DSH' })]);
  });

  it('uses the hostname when an explicitly empty Remote Host instance name overrides the environment', async () => {
    setRemoteInstanceName('Environment DSH');
    const remote = await startRemoteHost(remoteNativeHost(), { instanceName: '' });
    expect(remote.registrations).toEqual([expect.objectContaining({ name: hostname() })]);
  });

  it('uses the Remote Host instance name from the environment when configuration is blank', async () => {
    setRemoteInstanceName('Environment DSH');
    const remote = await startRemoteHost(remoteNativeHost(), { instanceName: '   ' });
    expect(remote.registrations).toEqual([expect.objectContaining({ name: 'Environment DSH' })]);
  });

  it.each([
    ['empty', '', ''],
    ['blank', '   ', '   '],
    ['unset', undefined, undefined],
  ])('uses the hostname when Remote Host instance name configuration and environment are %s', async (_kind, instanceName, environmentName) => {
    setRemoteInstanceName(environmentName);
    const remote = await startRemoteHost(remoteNativeHost(), { instanceName });
    expect(remote.registrations).toEqual([expect.objectContaining({ name: hostname() })]);
  });

  it('projects only exact top-level native Agents and retains them after Remote Host transport closure', async () => {
    const native = remoteNativeHost();
    const oldAgent = native.addRoot('native-one');
    const remote = await startRemoteHost(native);
    expect(remote.credentials).toEqual(['Bearer remote-test-key']);
    expect(remote.registrations).toEqual([expect.objectContaining({ installationId: expect.any(String), name: 'Test DSH', providerId: 'dsh' })]);
    const identityPath = join(remote.identityHome, 'agent-remote-control', 'identity.json');
    expect(JSON.parse(await readFile(identityPath, 'utf8'))).toEqual({ installationId: remote.registrations[0] && expect.any(String) });
    expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
    expect((await remote.request('/remote/attach', 'binding-one', JSON.stringify({ nativeSessionId: 'native-one' }))).status).toBe(200);
    expect((await remote.request('/v1/sessions/binding-one/snapshot?protocolVersion=1.1.0', 'binding-one')).status).toBe(200);
    expect(native.createCalls).toEqual([]);

    const replacement = native.replaceRoot('native-one');
    expect((await remote.request('/remote/attach', 'binding-one', JSON.stringify({ nativeSessionId: 'native-one' }))).status).toBe(200);
    native.dispose(oldAgent);
    expect((await remote.request('/v1/sessions/binding-one/snapshot?protocolVersion=1.1.0', 'binding-one')).status).toBe(200);
    native.dispose(replacement);
    await vi.waitFor(async () => expect((await remote.request('/v1/sessions/binding-one/snapshot?protocolVersion=1.1.0', 'binding-one')).status).toBe(403));
    await remote.host.close();
    expect(native.disposed).toEqual(['native-one', 'native-one']);
  });

  it('resumes a persisted native session when Remote Host attaches after a cold start', async () => {
    const native = remoteNativeHost();
    native.addColdSession('native-cold');
    const remote = await startRemoteHost(native);

    expect((await remote.request('/remote/attach', 'binding-cold', JSON.stringify({ nativeSessionId: 'native-cold' }))).status).toBe(200);
    expect(native.resolveCalls).toEqual(['native-cold']);
    expect((await remote.request('/v1/sessions/binding-cold/snapshot?protocolVersion=1.1.0', 'binding-cold')).status).toBe(200);

    await remote.host.close();
  });

  it('returns an opaque recovery failure when a persisted native session cannot resume', async () => {
    const native = remoteNativeHost();
    native.failColdSession('native-failed', 'gateway/internal');
    const remote = await startRemoteHost(native);

    const response = await remote.request('/remote/attach', 'binding-failed', JSON.stringify({ nativeSessionId: 'native-failed' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Native Remote Session recovery failed.', code: 'session_recovery_failed' });
    expect(native.resolveCalls).toEqual(['native-failed']);

    await remote.host.close();
  });

  it('does not list or attach a native subagent that appears in the runtime root registry', async () => {
    const native = remoteNativeHost();
    native.addRoot('native-subagent', { origin: 'subagent' });
    const remote = await startRemoteHost(native);

    expect(await (await remote.request('/remote/catalog')).json()).toMatchObject({ items: [] });
    const response = await remote.request('/remote/attach', 'binding-subagent', JSON.stringify({ nativeSessionId: 'native-subagent' }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Native Remote Session is unavailable.', code: 'session_unavailable' });

    await remote.host.close();
  });

  it('creates an opaque native session through DSH Web before borrowing it and preserves binding conflicts', async () => {
    const native = remoteNativeHost();
    const remote = await startRemoteHost(native);
    const create = () => remote.request('/remote/create', 'binding-one', JSON.stringify({ nativeSessionId: 'native-created', workspaceId: 'workspace-one' }));
    expect(await (await create()).json()).toEqual({ nativeSessionId: 'native-created' });
    expect(native.createCalls).toEqual([{ sessionId: 'native-created', workspaceId: 'workspace-one' }]);
    expect((await remote.request('/remote/attach', 'binding-two', JSON.stringify({ nativeSessionId: 'native-created' }))).status).toBe(409);
    expect(await (await remote.request('/remote/workspaces')).json()).toEqual({ workspaces: [{ id: 'workspace-one', name: 'Workspace one', path: '/tmp/workspace-one' }] });
    expect(await (await remote.request('/remote/catalog?limit=1')).json()).toMatchObject({
      items: [expect.objectContaining({ nativeSessionId: 'native-created', providerId: 'dsh' })], hasMore: false,
    });
    expect((await remote.request('/remote/catalog?unknown=value')).status).toBe(400);
  });


  it('projects live native events from an attached Remote Host session', async () => {
    const native = remoteNativeHost();
    const agent = native.addRoot('native-one');
    const remote = await startRemoteHost(native);
    expect((await remote.request('/remote/attach', 'binding-one', JSON.stringify({ nativeSessionId: 'native-one' }))).status).toBe(200);

    remote.openStream('native-events', 'binding-one');
    await vi.waitFor(() => expect(remote.streamFrames('native-events')).toContainEqual(expect.objectContaining({
      type: 'stream_opened',
    })), { timeout: 3000 });
    remote.sendStream('native-events', { protocolVersion: '1.1.0', type: 'negotiate' });
    await vi.waitFor(() => expect(remote.streamFrames('native-events')).toContainEqual(expect.objectContaining({
      type: 'agent_snapshot',
    })), { timeout: 3000 });
    remote.sendStream('native-events', { protocolVersion: '1.1.0', type: 'timeline_subscription', payload: {
      requestId: 'subscribe-native-events', agentIds: ['binding-one'],
    } });
    await vi.waitFor(() => expect(remote.streamFrames('native-events')).toContainEqual(expect.objectContaining({
      type: 'timeline_subscribed',
    })), { timeout: 3000 });

    native.append(agent, native.event('turn/start', 1, { turn: 1 }));
    native.append(agent, native.event('turn/end', 2, { turn: 1, reason: { kind: 'failed', error: { message: 'Native failure' } } }));
    await vi.waitFor(() => expect(remote.streamFrames('native-events')).toContainEqual(expect.objectContaining({
      type: 'agent_stream', payload: expect.objectContaining({ event: expect.objectContaining({
        type: 'turn_failed', error: 'Native failure',
      }) }),
    })), { timeout: 3000 });
  });

  it('lists persisted native sessions before any Agent is restored', async () => {
    const native = remoteNativeHost();
    native.addColdSession('native-cold', { createdAt: 1_725_000_000_000, cwd: '/tmp/native-cold' });
    const remote = await startRemoteHost(native);

    const response = await remote.request('/remote/catalog');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{
      nativeSessionId: 'native-cold', providerId: 'dsh', title: 'native-cold',
      workspace: '/tmp/native-cold', createdAt: '2024-08-30T06:40:00.000Z',
      updatedAt: '2024-08-30T06:40:00.000Z', state: 'idle',
    }], hasMore: false });
    expect(native.resolveCalls).toEqual([]);
    expect(native.eventReads()).toBe(0);
    await remote.host.close();
  });

  it('reads exact native metadata without attaching or restoring a session', async () => {
    const native = remoteNativeHost();
    native.addColdSession('native-cold', { createdAt: 1_725_000_000_000, cwd: '/tmp/native-cold' });
    const titled = native.addRoot('native-titled', {
      createdAt: 1_725_000_000_000,
      events: [native.event('session/title', 1_725_000_000_100, { title: 'Original title' })],
    });
    const remote = await startRemoteHost(native);
    const cold = await remote.request('/remote/catalog/session?nativeSessionId=native-cold');
    expect(cold.status).toBe(200);
    expect(await cold.json()).toMatchObject({ nativeSessionId: 'native-cold', title: 'native-cold', workspace: '/tmp/native-cold' });
    const current = await remote.request('/remote/catalog/session?nativeSessionId=native-titled');
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ nativeSessionId: 'native-titled', providerId: 'dsh', title: 'Original title' });
    const readsBeforeUpdate = native.eventReads();
    native.append(titled, native.event('session/title', 1_725_000_000_200, { title: 'Current working directory' }));
    expect(await (await remote.request('/remote/catalog/session?nativeSessionId=native-titled')).json())
      .toMatchObject({ nativeSessionId: 'native-titled', title: 'Current working directory' });
    expect(native.eventReads()).toBe(readsBeforeUpdate + 1);
    expect(native.resolveCalls).toEqual([]);
    expect(native.createCalls).toEqual([]);
    expect((await remote.request('/v1/sessions/unbound/snapshot?protocolVersion=1.1.0', 'unbound')).status).toBe(403);
    const missing = await remote.request('/remote/catalog/session?nativeSessionId=missing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'session_unavailable' });
  });

  it('rejects ambiguous native metadata queries before reading native state', async () => {
    const native = remoteNativeHost();
    native.addRoot('native-one');
    const remote = await startRemoteHost(native);
    for (const query of ['', '?nativeSessionId=', '?nativeSessionId=%20', '?nativeSessionId=one&nativeSessionId=two', '?nativeSessionId=one&extra=1', `?nativeSessionId=${'x'.repeat(256)}`]) {
      const response = await remote.request(`/remote/catalog/session${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    }
    expect(native.eventReads()).toBe(0);
    expect(native.resolveCalls).toEqual([]);
    expect(native.createCalls).toEqual([]);
  });

  it('projects native titles, request metadata, and status without rescanning settled event history', async () => {
    const native = remoteNativeHost();
    const titled = native.addRoot('native-titled', {
      createdAt: 1_725_000_000_000,
      cwd: '/tmp/native-titled',
      status: 'running',
      model: 'native-request-model',
      events: [
        native.event('user/message', 1_725_000_000_100, {
          content: [{ type: 'text', text: 'Use this only when a native title is absent.' }], source: { kind: 'user' },
        }),
        native.event('session/title', 1_725_000_000_200, { title: 'A native session title' }),
      ],
    });
    native.addRoot('native-fallback', {
      createdAt: 1_725_000_000_000,
      events: [
        native.event('user/message', 1_725_000_000_150, {
          content: [{ type: 'text', text: 'First user prompt becomes the directory title.' }], source: { kind: 'user' },
        }),
      ],
    });
    const remote = await startRemoteHost(native);

    const initial = await (await remote.request('/remote/catalog?limit=100')).json() as { items: Array<Record<string, unknown>> };
    expect(initial.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nativeSessionId: 'native-titled', title: 'A native session title', workspace: '/tmp/native-titled',
        model: 'native-request-model', state: 'running', updatedAt: '2024-08-30T06:40:00.200Z',
      }),
      expect.objectContaining({ nativeSessionId: 'native-fallback', title: 'First user prompt becomes the directory title.' }),
    ]));
    const readsAfterInitialCatalog = native.eventReads();

    await remote.request('/remote/catalog/revision');
    await remote.request('/remote/catalog?limit=100');
    expect(native.eventReads()).toBe(readsAfterInitialCatalog);

    native.append(titled, native.event('session/title', 1_725_000_000_300, { title: 'Renamed native title' }));
    native.setStatus(titled, 'idle');
    const updated = await (await remote.request('/remote/catalog?limit=100')).json() as { items: Array<Record<string, unknown>> };
    expect(updated.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nativeSessionId: 'native-titled', title: 'Renamed native title', state: 'idle', updatedAt: '2024-08-30T06:40:00.300Z',
      }),
    ]));
    expect(native.eventReads()).toBe(readsAfterInitialCatalog + 1);
  });
});

function remoteNativeHost() {
  type NativeEvent = { type: string; data: unknown; seq: number; time: number };
  type NativeRoot = {
    id: string;
    status: 'idle' | 'running';
    options: Record<string, never>;
    session: {
      id: string;
      header: { createdAt: number; cwd?: string; origin?: string };
      readonly events: readonly NativeEvent[];
      snapshotEvents(): readonly NativeEvent[];
      requestHeader(): { config: { model: string } } | undefined;
    };
    followup(): void;
    steer(): void;
    cancel(): void;
  };
  const roots = new Map<string, NativeRoot>();
  const coldSessions = new Map<string, RootOptions>();
  const coldFailures = new Map<string, string>();
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const createCalls: Array<{ sessionId: string; workspaceId?: string }> = [];
  const resolveCalls: string[] = [];
  const disposed: string[] = [];
  const answers: Array<{ sessionId: string; answers: unknown }> = [];
  const interactionFrames = new FrameQueue();
  const pendingQuestions = new Map<string, { sessionId: string; questions: unknown }>();
  const appenders = new WeakMap<NativeRoot, (record: NativeEvent) => NativeEvent>();
  let eventReads = 0;
  type RootOptions = {
    createdAt?: number;
    cwd?: string;
    origin?: string;
    status?: 'idle' | 'running';
    model?: string;
    events?: NativeEvent[];
  };
  const event = (type: string, time: number, data: unknown): NativeEvent => ({ type, data, time, seq: -1 });
  const countedEvents = (events: NativeEvent[]): readonly NativeEvent[] => new Proxy(events, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) eventReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const createAgent = (sessionId: string, options: RootOptions = {}) => {
    let records = (options.events ?? []).map((record, index) => ({ ...record, seq: index }));
    let events = countedEvents(records);
    const agent: NativeRoot = {
      id: sessionId, status: options.status ?? 'idle', options: {},
      session: {
        id: sessionId,
        header: { createdAt: options.createdAt ?? 0, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.origin === undefined ? {} : { origin: options.origin }) },
        get events() { return events; },
        snapshotEvents() { return events; },
        requestHeader: () => options.model === undefined ? undefined : { config: { model: options.model } },
      },
      followup: () => undefined, steer: () => undefined, cancel: () => undefined,
    };
    return {
      agent,
      append(record: NativeEvent) {
        const appended = { ...record, seq: records.length };
        records = [...records, appended];
        events = countedEvents(records);
        return appended;
      },
    };
  };
  const addRoot = (sessionId: string, options?: RootOptions) => {
    const root = createAgent(sessionId, options);
    const agent = root.agent;
    appenders.set(agent, root.append);
    roots.set(sessionId, agent);
    return agent;
  };
  const addColdSession = (sessionId: string, options?: RootOptions) => {
    coldSessions.set(sessionId, options ?? {});
  };
  const failColdSession = (sessionId: string, code: string) => {
    coldFailures.set(sessionId, code);
  };
  const append = (agent: NativeRoot, record: NativeEvent) => {
    const appended = appenders.get(agent)!(record);
    for (const listener of listeners.get('session/event') ?? []) listener(agent.session, appended);
  };
  const setStatus = (agent: NativeRoot, status: 'idle' | 'running') => { agent.status = status; };
  const dispose = (agent: NativeRoot) => {
    if (roots.get(agent.session.id) === agent) roots.delete(agent.session.id);
    disposed.push(agent.session.id);
    for (const listener of listeners.get('agent/disposed') ?? []) listener({ agent });
  };
  const context = {
    get(name: string) {
      if (name === 'tools') return { get: () => ({}), schemas: () => [{}] };
      return undefined;
    },
    on(event: string, listener: (...args: any[]) => void) {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return () => eventListeners.delete(listener);
    },
    agents: { roots: () => [...roots.values()] },
    sessions: { flush: async () => undefined },
    sessionQuery: {
      async listSessions() {
        return [...coldSessions].map(([id, options]) => ({
          header: { version: 0, id, isSeeded: false, createdAt: options.createdAt ?? 0, cwd: options.cwd },
          live: false, persisted: true,
        }));
      },
    },
    sessionController: {
      async create(request: { sessionId: string; workspaceId?: string }) {
        createCalls.push({ ...request });
        if (!roots.has(request.sessionId)) addRoot(request.sessionId);
        return { sessionId: request.sessionId };
      },
      async resolveAgent(sessionId: string) {
        resolveCalls.push(sessionId);
        const live = roots.get(sessionId);
        if (live) return { agent: live };
        const failure = coldFailures.get(sessionId);
        if (failure) return { error: { code: failure } };
        const cold = coldSessions.get(sessionId);
        if (!cold) return { error: { code: 'session/not-found' } };
        coldSessions.delete(sessionId);
        return { agent: addRoot(sessionId, cold) };
      },
      async modelCatalog() { return { default: { model: 'gpt-5.6-luna' }, routableProviders: [], groups: [], failures: [] }; },
    },
    workspaceRegistry: { list: () => [{ id: 'workspace-one', title: 'Workspace one', path: '/tmp/workspace-one' }] },
  };
  const requestQuestion = (sessionId: string, rpcId: string) => {
    const questions = [{ id: 'destination', question: 'Where?', options: [{ label: 'Home' }] }];
    pendingQuestions.set(rpcId, { sessionId, questions });
    interactionFrames.push({ rpcId, payload: { type: 'question/requested', sessionId, questions } });
  };
  return { context, addRoot, addColdSession, failColdSession, replaceRoot: addRoot, append, setStatus, event, eventReads: () => eventReads,
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0, dispose, createCalls, resolveCalls, disposed,
    requestQuestion, answers };
}
