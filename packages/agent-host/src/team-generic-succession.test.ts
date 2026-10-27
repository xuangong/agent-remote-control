import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import type { AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey, type NativeSessionRef, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import type { SessionWireAgent } from '@orchardworks/agent-remote-relay';
import { TeamBroker } from '../../agent-remote-hosted/src/teams.js';
import type { SavedTeam } from '../../agent-remote-hosted/src/team-delivery.js';
import { TeamRuntime, type TeamRuntimeAccess } from './team.js';
import { SessionRoles } from './session-role-succession.js';

it.each(['leader', 'member'] as const)('moves the %s seat, its tools and its deliveries to a successor on another provider', async role => {
  const root = await mkdtemp(join(tmpdir(), 'team-generic-'));
  const codex = (nativeSessionId: string): NativeSessionRef => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId });
  const successor: NativeSessionRef = { controllerId: 'controller', providerId: 'claude', nativeSessionId: 'C' };
  let state: SavedTeam[] = [], committed = false, relaySupport = true;
  const extensions = new Map<string, AgentSessionExtensions>(), deliveries: string[] = [];
  // Role routing: the seat's session A is handed off to C, on another provider.
  const resolve = (anchor: NativeSessionRef) => ({ anchor, target: committed && nativeSessionRefKey(anchor) === nativeSessionRefKey(codex('A')) ? successor : anchor,
    operationIds: committed ? ['generic'] : [] });
  const assertCurrent = (anchor: NativeSessionRef, actual: NativeSessionRef) => {
    if (nativeSessionRefKey(resolve(anchor).target) !== nativeSessionRefKey(actual)) throw new Error('Recipient is not current');
  };
  let runtime: TeamRuntime;
  const broker = new TeamBroker({ read: () => state, now: Date.now, assertHost() {},
    resolveSession: (_host, providerId, id) => resolve({ controllerId: 'controller', providerId, nativeSessionId: id }).target,
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
    controllerId: 'controller', sessionRouting: { resolve, assertCurrent }, available: () => true, supportedProviders: () => ['codex', 'claude'],
    genericSuccession: () => relaySupport,
    async create(_provider, _cwd, value) { const id = extensions.size === 0 ? (role === 'leader' ? 'A' : 'leader') : 'A'; extensions.set(id, value); return id; },
    async acquire(providerId, id) {
      return { release() {}, agent: {
        agentId: `${providerId}:${id}`, snapshot: () => ({ payload: { status: 'idle', activeTurn: null, pendingInteractions: [], runtimeInfo: { cwd: root }, capabilities: { sendMessage: true } } }),
        async sendMessage() { deliveries.push(`${providerId}:${id}`); return { disposition: 'started' }; },
      } as unknown as SessionWireAgent };
    },
    async execute(_agent, _op, dispatch) { await dispatch.beforeDispatch?.(); return dispatch.dispatch(); },
  };
  runtime = new TeamRuntime(root, access, request, 1000000);
  const roles = new SessionRoles([runtime]);
  try {
    let team = await broker.create({ operationId: 'team', source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'source', title: 'Source' } });
    if (role === 'member') team = await broker.action({ action: 'add_member', teamId: team.id, operationId: 'member', hostId: 'host', providerId: 'codex', cwd: root, name: 'Worker', responsibility: 'Verify' });
    const seat = team.members.find(member => member.nativeSessionId === 'A')!;
    const original = extensions.get('A')!.tools!.find(tool => tool.name === 'read_team')!;

    // The Relay must route Team recipients across the handoff, and the successor's provider must run Team tools.
    relaySupport = false;
    expect(await roles.genericSuccession(codex('A'), 'claude')).toMatchObject({ allowed: false, reason: /Update the Relay/ });
    relaySupport = true;
    expect(await roles.genericSuccession(codex('A'), 'opencode')).toMatchObject({ allowed: false, reason: /cannot run Team tools/ });
    expect(await roles.genericSuccession(codex('A'), 'claude')).toEqual({ allowed: true });
    expect(await roles.genericSuccession(codex('source'), 'claude')).toEqual({ allowed: true });

    // Before the commit the successor carries the role, fenced; the original keeps working.
    const candidate = (await roles.extensions(codex('A'), () => successor))!.tools!.find(tool => tool.name === 'read_team')!;
    await expect(candidate.execute({})).rejects.toThrow(/not current/);
    expect(JSON.parse(await original.execute({})).id).toBe(team.id);

    committed = true;
    await expect(original.execute({})).rejects.toThrow(/not current/);
    expect(await roles.extensions(codex('A'), () => codex('A'))).toBeUndefined();
    const roster = JSON.parse(await candidate.execute({}));
    expect(roster.members.find((member: { id: string }) => member.id === seat.id)).toMatchObject({ providerId: 'claude', nativeSessionId: 'C' });
    expect(broker.list()[0]!.members.find(member => member.id === seat.id)).toMatchObject({ providerId: 'claude', nativeSessionId: 'C' });
    expect((await roles.extensions(successor, () => successor))?.tools?.map(tool => tool.name)).toContain('read_team');

    const message = { id: 'delivery', from: team.members.find(member => member.id !== seat.id)?.id ?? seat.id, to: seat.id, text: 'After the handoff', createdAt: 1, status: 'queued' as const };
    state[0]!.messages.push(message);
    await runtime.tick();
    expect(deliveries.filter(id => id === 'claude:C' || id === 'codex:A')).toEqual(['claude:C']);
    expect(state[0]!.messages.find(item => item.id === 'delivery') ?? state[0]!.deliveryReceipts?.find(item => item.id === 'delivery'))
      .toMatchObject({ status: 'accepted', resolvedTarget: successor });
  } finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);
