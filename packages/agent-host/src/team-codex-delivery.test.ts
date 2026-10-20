import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { expect, it } from 'vitest';
import { CodexAppServerProvider } from '@orchardworks/agent-provider-codex';
import type { AgentSessionConfig, AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { Team, TeamMessage } from '@orchardworks/agent-remote-protocol';
import { createFakeChildProcess } from '../../agent-provider-codex/src/test-utils/fake-child.js';
import { createRemoteHostBroker } from '../../agent-remote-lab/src/server/remote-host-broker.js';
import { createAgentHost, type AgentHostDirectory } from './host.js';

interface NativeRequest { id: number; method: string; params: Record<string, unknown> }

async function codexSession(nativeId: string, config: AgentSessionConfig) {
  const child = createFakeChildProcess(), requests: NativeRequest[] = [];
  const responses: Array<{ id: string; result?: unknown }> = [];
  let turns = 0;
  const reader = readline.createInterface({ input: child.stdin });
  reader.on('line', line => {
    const request = JSON.parse(line) as NativeRequest;
    if (typeof request.id !== 'number') {
      if (!request.method) responses.push(request as unknown as typeof responses[number]);
      return;
    }
    requests.push(request);
    const result = request.method === 'thread/start' ? { thread: { id: nativeId }, model: 'fixture-model' }
      : request.method === 'skills/list' ? { data: [] }
      : request.method === 'model/list' ? { data: [{ model: 'fixture-model' }] }
      : request.method === 'turn/start' ? { turn: { id: `turn-${++turns}`, status: 'inProgress' } }
      : request.method === 'turn/steer' ? { turnId: request.params.expectedTurnId }
      : {};
    child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  });
  const adapter = new CodexAppServerProvider({ spawn: () => child, requestTimeoutMs: 1000 });
  const session = await adapter.createSession(config);
  return {
    session, requests, responses,
    notify(method: string, params: object) {
      child.stdout.write(`${JSON.stringify({ method, params: { threadId: nativeId, ...params } })}\n`);
    },
    request(method: string, params: object) {
      child.stdout.write(`${JSON.stringify({ id: 'native-pending', method, params: { threadId: nativeId, ...params } })}\n`);
    },
  };
}

async function teamTransport() {
  const root = await mkdtemp(join(tmpdir(), 'arc-team-codex-'));
  const server = createServer();
  const broker = createRemoteHostBroker({ origin: 'http://127.0.0.1:6175', ownerSubject: 'owner', principalSubject: () => 'owner' });
  broker.install(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(base + path, {
      signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
    return value as T;
  };
  const hosts: Array<ReturnType<typeof createAgentHost>> = [];
  async function host(name: string) {
    const natives = new Map<string, Awaited<ReturnType<typeof codexSession>>>();
    const extensions = new Map<string, AgentSessionExtensions>();
    const directory: AgentHostDirectory = {
      providerId: 'codex', list: () => [], workspaces: () => [],
      async create(input) {
        const id = `${name}-${natives.size}`;
        natives.set(id, await codexSession(id, { ...input, cwd: input.cwd ?? root, sessionId: id }));
        extensions.set(id, input);
        return id;
      },
      async open(id, options) {
        if (options?.extensions) extensions.set(id, options.extensions);
        let native = natives.get(id);
        if (!native) {
          native = await codexSession(id, { ...options?.extensions, cwd: root, sessionId: id });
          natives.set(id, native);
        }
        return native.session;
      },
      async close() { await Promise.all([...natives.values()].map(native => native.session.dispose())); },
    };
    const { key } = await request<{ key: string }>('/v1/remote/pairings', {});
    const instance = createAgentHost({
      installationId: name, name, team: { stateDirectory: join(root, name), tickMs: 20 },
      registrations: [{ directory, adapter: new CodexAppServerProvider({ spawn: () => { throw new Error('Use directory'); } }) }],
      uplink: { url: base.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: key },
    });
    hosts.push(instance);
    return { natives, extensions, id: (await instance.ready).hostId };
  }
  return {
    root, request, host,
    async close() {
      await Promise.all(hosts.map(host => host.close()));
      await broker.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

it.each(['working', 'question', 'approval'] as const)('delivers to Codex during %s, preserves native interactions and settles only the correlated input', async state => {
  const transport = await teamTransport(), { root, request, host } = transport;
  try {
    const mac = await host('mac'), win = await host('win');
    const team = await request<Team>('/v1/remote/teams/create', {
      operationId: 'create', source: { hostId: mac.id, providerId: 'codex', nativeSessionId: 'source', title: 'Working Codex session' },
    });
    const leader = team.members[0]!;
    const registered = await request<Team>('/v1/remote/teams/action', {
      teamId: team.id, action: 'add_member', operationId: 'worker', hostId: win.id, providerId: 'codex',
      name: 'Worker', cwd: root, responsibility: 'Return evidence',
    });
    const member = registered.members[1]!;
    const native = mac.natives.get(leader.nativeSessionId!)!;
    const starts = () => native.requests.filter(request => request.method === 'turn/start');
    const steers = () => native.requests.filter(request => request.method === 'turn/steer');
    const currentTeam = async () => (await request<{ teams: Team[] }>('/v1/remote/teams')).teams[0]!;
    await expect.poll(() => starts().length, { timeout: 3000 }).toBe(1);
    await expect.poll(async () => (await native.session.runtimeInfo()).status, { timeout: 3000 }).toBe('running');
    await expect.poll(async () => (await currentTeam()).messages.length, { timeout: 3000 }).toBe(0);
    if (state !== 'working') {
      native.request(state === 'question' ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval', state === 'question'
        ? { turnId: 'turn-1', itemId: 'question', questions: [{ id: 'path', header: 'Path', question: 'Which path?', options: [{ label: 'A', description: 'Path A' }] }] }
        : { turnId: 'turn-1', itemId: 'command', command: 'pwd', availableDecisions: ['accept', 'decline'] });
      native.notify('thread/status/changed', { status: { type: 'active', activeFlags: [state === 'question' ? 'waitingOnUserInput' : 'waitingOnApproval'] } });
      await expect.poll(async () => (await native.session.runtimeInfo()).status, { timeout: 3000 }).toBe('waiting');
    }
    const send = win.extensions.get(member.nativeSessionId!)!.tools!.find(tool => tool.name === 'send_team_message')!;
    const message = JSON.parse(await send.execute({ to: leader.id, operationId: 'result', text: 'Fresh evidence during the active turn.' })) as TeamMessage;
    await expect.poll(() => steers().length, { timeout: 3000 }).toBe(1);
    await expect.poll(async () => (await currentTeam()).messages.find(row => row.id === message.id)?.acceptance, { timeout: 3000 }).toBe('queued');
    expect((await currentTeam()).messages.find(row => row.id === message.id)).toMatchObject({ status: 'accepted', acceptance: 'queued' });
    expect((await native.session.runtimeInfo()).status).toBe(state === 'working' ? 'running' : 'waiting');
    expect(native.responses).toEqual([]);
    expect(starts()).toHaveLength(1);

    const steer = steers()[0]!;
    expect(steer.params.clientUserMessageId).toEqual(expect.any(String));
    expect(steer.params.input).toEqual([{ type: 'text', text: expect.stringContaining(message.text), text_elements: [] }]);
    const echo = { turnId: 'turn-1', item: { type: 'userMessage', id: 'native-message', clientId: steer.params.clientUserMessageId, content: steer.params.input } };
    native.notify('item/started', { ...echo, item: { ...echo.item, clientId: 'unrelated-input' } });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await currentTeam()).messages.find(row => row.id === message.id)?.acceptance).toBe('queued');

    native.notify('item/started', echo);
    await expect.poll(async () => (await currentTeam()).messages.length, { timeout: 3000 }).toBe(0);
    const read = mac.extensions.get(leader.nativeSessionId!)!.tools!.find(tool => tool.name === 'read_team')!;
    const inbox = JSON.parse(await read.execute({})) as { receipts: TeamMessage[] };
    expect(inbox.receipts.find(receipt => receipt.id === message.id)).toMatchObject({ status: 'accepted', acceptance: 'handled' });
    expect((await native.session.runtimeInfo()).status).toBe(state === 'working' ? 'running' : 'waiting');
    expect(native.responses).toEqual([]);
    if (state !== 'working') {
      await native.session.respondToInteraction(`${state === 'question' ? 'question' : 'tool'}:native-pending`, state === 'question'
        ? { kind: 'question', answers: [{ questionId: 'path', selectedValues: ['A'] }] }
        : { kind: 'tool_approval', decision: 'deny' });
      await expect.poll(() => native.responses.length, { timeout: 3000 }).toBe(1);
      expect(native.responses[0]).toEqual({ id: 'native-pending', result: state === 'question' ? { answers: { path: { answers: ['A'] } } } : { decision: 'decline' } });
    }

    native.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await expect.poll(async () => (await currentTeam()).members.find(row => row.id === leader.id)?.activity, { timeout: 3000 }).toBe('idle');
    expect(starts()).toHaveLength(1);
    expect(steers()).toHaveLength(1);
    expect(native.requests.some(request => request.method === 'turn/interrupt')).toBe(false);
    expect((await currentTeam()).messages).toEqual([]);
  } finally { await transport.close(); }
}, 15000);
