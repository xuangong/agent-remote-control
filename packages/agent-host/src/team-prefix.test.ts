import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { AgentOperationRejectedError, type AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey, type NativeSessionRef, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import type { SessionWireAgent } from '@orchardworks/agent-remote-relay';
import { TeamBroker } from '../../agent-remote-hosted/src/teams.js';
import type { SavedTeam } from '../../agent-remote-hosted/src/team-delivery.js';
import { TeamRuntime, type TeamRuntimeAccess } from './team.js';

it.each(['leader', 'member'] as const)('keeps the %s seat and tools on a released prefix recipient and preserves unknown delivery after restart', async role => {
  const root = await mkdtemp(join(tmpdir(), 'team-prefix-'));
  let state: SavedTeam[] = [], current = 'A', frozen = false, available = true, failSend = false, routeUnavailable = false;
  const extensions = new Map<string, AgentSessionExtensions>(), deliveries: string[] = [], retained = new Map<string, number>();
  const ref = (nativeSessionId: string): NativeSessionRef => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId });
  const resolve = (anchor: NativeSessionRef) => { if (routeUnavailable && anchor.nativeSessionId === 'A') throw new Error('Route unavailable'); return { anchor, target: ref(anchor.nativeSessionId === 'A' ? current : anchor.nativeSessionId), operationIds: current === 'A' ? [] : ['prefix'] }; };
  const assertCurrent = (anchor: NativeSessionRef, actual: NativeSessionRef) => {
    if (nativeSessionRefKey(resolve(anchor).target) !== nativeSessionRefKey(actual) || frozen) throw new Error('Recipient is not current or released');
  };
  let runtime: TeamRuntime;
  const broker = new TeamBroker({ read: () => state, now: Date.now, assertHost() {},
    resolveSession: (_host, _provider, id) => resolve(ref(id)).target,
    assertRecipient: () => { if (frozen) throw new Error('Recipient frozen'); },
    async change(update) { const draft = structuredClone(state), value = structuredClone(update(draft)); state = draft; return value; },
    async createSeat(_host, seat) { return runtime.create(seat); },
  });
  const server = createServer((req, res) => { void (async () => {
    let body = ''; for await (const chunk of req) body += chunk;
    try { res.end(JSON.stringify(await broker.hostCall('host', JSON.parse(body)))); }
    catch (error) { res.statusCode = 409; res.end(JSON.stringify({ error: String(error) })); }
  })(); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const request = async (call: TeamHostCall) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { method: 'POST', body: JSON.stringify(call), signal: AbortSignal.timeout(3000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  };
  const access: TeamRuntimeAccess = {
    controllerId: 'controller', sessionRouting: { resolve, assertCurrent }, available: () => available, supportedProviders: () => ['codex'],
    async create(_provider, _cwd, value) { const id = extensions.size === 0 ? (role === 'leader' ? 'A' : 'leader') : 'A'; extensions.set(id, value); return id; },
    async acquire(_provider, id) {
      retained.set(id, (retained.get(id) ?? 0) + 1);
      return { release() { retained.set(id, retained.get(id)! - 1); }, agent: {
        agentId: id, snapshot: () => ({ payload: { status: 'idle', activeTurn: null, pendingInteractions: [], runtimeInfo: { cwd: root }, capabilities: { sendMessage: true } } }),
        async sendMessage() { deliveries.push(id); if (failSend) throw new Error('Native receipt lost'); return { disposition: 'started' }; },
      } as unknown as SessionWireAgent };
    },
    async execute(_agent, _op, dispatch) { if (frozen) throw new AgentOperationRejectedError('frozen', 'Recipient frozen'); await dispatch.beforeDispatch?.(); return dispatch.dispatch(); },
  };
  runtime = new TeamRuntime(root, access, request, 1000000);
  try {
    let team = await broker.create({ operationId: 'team', source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'source', title: 'Source' } });
    if (role === 'member') team = await broker.action({ action: 'add_member', teamId: team.id, operationId: 'member', hostId: 'host', providerId: 'codex', cwd: root, name: 'Worker', responsibility: 'Verify' });
    const seat = team.members.find(member => member.nativeSessionId === 'A')!;
    const stale = extensions.get('A')!.tools!.find(tool => tool.name === 'read_team')!;
    const candidate = (await runtime.extensions('codex', 'A', () => 'B'))!.tools!.find(tool => tool.name === 'read_team')!;
    await expect(candidate.execute({})).rejects.toThrow(/current|released/);
    await runtime.tick();
    current = 'B'; frozen = true;
    await expect(runtime.extensions('codex', 'A')).resolves.toBeUndefined();
    await expect(stale.execute({})).rejects.toThrow(/current|released/);
    await expect(candidate.execute({})).rejects.toThrow(/current|released/);
    const message = { id: 'delivery', from: team.members[0]!.id, to: seat.id, text: 'Once', createdAt: 1, status: 'queued' as const };
    state[0]!.messages.push(message);
    await runtime.tick(); expect(state[0]!.messages.find(item => item.id === 'delivery')!.status).toBe('queued');
    expect(deliveries.filter(id => id === 'B')).toEqual([]);
    frozen = false; failSend = true;
    expect(JSON.parse(await candidate.execute({})).members.find((member: any) => member.id === seat.id).nativeSessionId).toBe('B');
    await runtime.tick();
    expect(deliveries.filter(id => id === 'B')).toEqual(['B']);
    expect(state[0]!.messages.find(item => item.id === 'delivery')).toMatchObject({ status: 'unknown', resolvedTarget: ref('B') });
    expect(runtime.hasUnsettledRecipient(ref('B'))).toBe(true);
    expect(retained.get('A')).toBe(0);
    await runtime.close(); runtime = new TeamRuntime(root, access, request, 1000000); await runtime.ready;
    await runtime.tick(); expect(deliveries.filter(id => id === 'B')).toEqual(['B']);
    expect((await runtime.extensions('codex', 'B'))?.tools?.map(tool => tool.name)).toContain('read_team');
    const saved = JSON.parse(await readFile(join(root, 'seats.json'), 'utf8'));
    expect(saved.find((row: any) => row.seat.member.id === seat.id).seat.member.nativeSessionId).toBe('A');
    expect(saved.find((row: any) => row.seat.member.id === seat.id).receipts.delivery.resolvedTarget).toEqual(ref('B'));
    if (role === 'member') {
      await broker.action({ action: 'archive', teamId: team.id });
      for (const member of team.members) await request({ action: 'presence', teamId: team.id, memberId: member.id, activity: 'idle' });
    }
    await broker.action({action:'resolve_message',teamId:team.id,messageId:'delivery',outcome:'accepted'});
    if (role === 'member') expect(await request({ action: 'poll' })).toEqual([]);
    await runtime.tick(); expect(runtime.hasUnsettledRecipient(ref('B'))).toBe(false);
    routeUnavailable = true; await runtime.tick();
    expect(broker.list()[0]!.members.find(member => member.id === seat.id)!.nativeSessionId).toBeUndefined();
    expect(retained.get('B')).toBe(0); expect(deliveries.filter(id => id === 'B')).toEqual(['B']);
  } finally { available = false; await runtime.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
}, 10000);
