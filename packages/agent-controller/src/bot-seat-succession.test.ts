import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentOperationRejectedError, type AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey, type NativeSessionRef, type Team, type TeamMember, type TeamMessage } from '@orchardworks/agent-remote-protocol';
import type { SessionWireAgent } from '@orchardworks/agent-session-runtime';
import { TeamBroker } from '@orchardworks/agent-relay-core/testing';
import type { SavedTeam } from '@orchardworks/agent-relay-core/testing';
import { TeamRuntime, type TeamRuntimeAccess } from './team.js';

/**
 * A bot's inbox seat across a handoff of its session. 'requester': the bot's main session, bound where it already is.
 * 'leader': the session the Controller created for a standing bot another bot made, whose tools and standing instructions the seat gives.
 * A successor session takes over delivery, and a handoff that is not committed never takes the seat or its tools early.
 */
async function fixture(role: 'requester' | 'leader') {
  const root = await mkdtemp(join(tmpdir(), 'bot-seat-succession-'));
  let current = 'A', frozen = false, available = true, failSend = false, routeUnavailable = false;
  const extensions = new Map<string, AgentSessionExtensions>(), deliveries: string[] = [], retained = new Map<string, number>();
  const ref = (nativeSessionId: string): NativeSessionRef => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId });
  const resolve = (anchor: NativeSessionRef) => {
    if (routeUnavailable && anchor.nativeSessionId === 'A') throw new Error('Route unavailable');
    return { anchor, target: ref(anchor.nativeSessionId === 'A' ? current : anchor.nativeSessionId), operationIds: [] };
  };
  const assertCurrent = (anchor: NativeSessionRef, actual: NativeSessionRef) => {
    if (nativeSessionRefKey(resolve(anchor).target) !== nativeSessionRefKey(actual) || frozen) throw new Error('Recipient is not current or released');
  };
  let state: SavedTeam[] = [], runtime: TeamRuntime;
  const broker = new TeamBroker({ read: () => state, now: Date.now, assertHost() {}, resolveSession: (_host, _provider, id) => resolve(ref(id)).target,
    assertRecipient: () => { if (frozen) throw new Error('Recipient frozen'); },
    tasks: { capable: () => true, assertHost() {} }, assistants: { groups: () => [], capable: () => true },
    async change(update) { const draft = structuredClone(state), value = structuredClone(update(draft)); state = draft; return value; },
    async createSeat(_host, seat) { return runtime.create(seat); },
  });
  const access: TeamRuntimeAccess = {
    controllerId: 'controller', sessionRouting: { resolve, assertCurrent }, available: () => available, supportedProviders: () => ['codex'], tasks: () => true,
    botTools: () => ({ name: 'bots', description: 'Bot tools', tools: [{ name: 'list_bots', description: 'List bots', inputSchema: { type: 'object', properties: {} }, execute: async () => '[]' }] }),
    async create(_provider, _creation, value) { extensions.set('A', value); return 'A'; },
    async acquire(_provider, id) {
      retained.set(id, (retained.get(id) ?? 0) + 1);
      return { release() { retained.set(id, retained.get(id)! - 1); }, agent: {
        agentId: id, snapshot: () => ({ payload: { status: 'idle', activeTurn: null, pendingInteractions: [], runtimeInfo: { cwd: root }, capabilities: { sendMessage: true } } }),
        async sendMessage() { deliveries.push(id); if (failSend) throw new Error('Native receipt lost'); return { disposition: 'started' }; },
      } as unknown as SessionWireAgent };
    },
    async execute(_agent, _op, dispatch) { if (frozen) throw new AgentOperationRejectedError('frozen', 'Recipient frozen'); await dispatch.beforeDispatch?.(); return dispatch.dispatch(); },
  };
  runtime = new TeamRuntime(root, access, call => broker.hostCall('host', call), 1_000_000);
  const source = { hostId: 'host', providerId: 'codex', nativeSessionId: role === 'requester' ? 'A' : 'source', title: 'Bot' };
  const botId = `b_${'1'.repeat(32)}`;
  const reserved: TeamMember = { id: 'bot', hostId: 'host', providerId: 'codex', role, name: 'Bot', responsibility: '', creation: 'reserved', activity: 'idle', summary: '', updatedAt: 1,
    ...(role === 'requester' ? { nativeSessionId: 'A' } : {}) };
  const member = await runtime.create({ teamId: 'team', source, member: reserved, inbox: { botId } });
  const delivery: TeamMessage = { id: 'delivery', from: 'bot', to: 'bot', text: 'Once', status: 'queued', createdAt: 1 };
  state = [{ id: 'team', operationId: 'inbox', revision: 1, source, title: 'Bot', status: 'active', members: [{ ...member, creation: 'ready' }], messages: [], createdAt: 1, updatedAt: 1, inbox: { botId } }];
  return {
    runtime, ref, extensions, deliveries, retained, member: state[0]!.members[0]!,
    team: () => state[0]!,
    handOff() { current = 'B'; frozen = true; },
    commit(options: { failSend?: boolean } = {}) { frozen = false; failSend = options.failSend ?? false; },
    loseRoute() { routeUnavailable = true; },
    send() { state[0]!.messages.push(delivery); },
    status: () => state[0]!.messages.find(message => message.id === delivery.id)?.status,
    async close() { available = false; await runtime.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
    restart: async () => { await runtime.close(); runtime = new TeamRuntime(root, access, call => broker.hostCall('host', call), 1_000_000); await runtime.ready; return runtime; },
    current: () => runtime,
    read: () => broker.hostCall('host', { action: 'read', teamId: 'team', memberId: 'bot' }) as Promise<Team>,
  };
}

it.each(['requester', 'leader'] as const)('keeps the %s seat of a bot\'s inbox on a released prefix recipient and keeps an unknown delivery unknown after restart', async role => {
  const f = await fixture(role);
  try {
    const own = role === 'leader' ? f.extensions.get('A')! : undefined;
    // An uncommitted handoff takes nothing: the candidate's tools and the old session's are refused, and a seat held in place gives no tools.
    if (role === 'leader') {
      expect(own.instructions).toContain('bot');
      expect((await f.runtime.extensions(f.ref('A'), () => f.ref('B')))?.tools?.map(tool => tool.name)).toContain('list_bots');
    } else expect(await f.runtime.extensions(f.ref('A'))).toBeUndefined();
    f.handOff();
    f.send();
    await f.runtime.tick();
    expect(f.status()).toBe('queued');
    expect(f.deliveries).toEqual([]);
    // The commit: the successor receives what waited, once, and a lost receipt stays unknown.
    f.commit({ failSend: true });
    await f.runtime.tick();
    expect(f.deliveries).toEqual(['B']);
    expect(f.team().messages.find(message => message.id === 'delivery')).toMatchObject({ status: 'unknown', resolvedTarget: f.ref('B') });
    expect(f.runtime.hasUnsettledRecipient(f.ref('B'))).toBe(true);
    expect(f.retained.get('A') ?? 0).toBe(0);
    const restarted = await f.restart();
    await restarted.tick();
    expect(f.deliveries).toEqual(['B']);
    // The successor holds the seat after a restart; the seat's tools follow it only for the seat the Controller made.
    const tools = (await f.current().extensions(f.ref('B')))?.tools?.map(tool => tool.name);
    if (role === 'leader') expect(tools).toContain('list_bots'); else expect(tools).toBeUndefined();
    // A vanished route releases the seat's session and delivers nothing more.
    f.loseRoute();
    await f.current().tick();
    expect(f.retained.get('B') ?? 0).toBe(0);
    expect(f.deliveries).toEqual(['B']);
  } finally { await f.close(); }
}, 5000);
