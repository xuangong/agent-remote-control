import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentMessageOptions } from '@orchardworks/agent-provider-sdk';
import type { AgentSnapshotPayload, NativeSessionRef, Team, TeamMessage } from '@orchardworks/agent-remote-protocol';
import { createOperationCache, createOperationExecutor, type SessionWireAgent } from '@orchardworks/agent-session-runtime';
import { TeamBroker } from '@orchardworks/agent-relay-core/testing';
import type { SavedTeam } from '@orchardworks/agent-relay-core/testing';
import { TeamRuntime, type TeamRuntimeAccess } from './team.js';

const pendingApproval: AgentSnapshotPayload['pendingInteractions'][number] = { requestId: 'approval', kind: 'tool_approval', toolCallId: 'call', toolName: 'shell', summary: 'Run', detail: { type: 'shell', command: 'pwd' }, allowedDecisions: ['allow', 'deny'], allowScopes: ['once'] };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'team-dispatch-')), cache = createOperationCache();
  const ref = (nativeSessionId: string): NativeSessionRef => ({ controllerId: 'controller', providerId: 'fixture', nativeSessionId });
  const payload: AgentSnapshotPayload = {
    id: 'worker', providerId: 'fixture', status: 'idle', createdAt: '2026-10-20', updatedAt: '2026-10-20', activeTurn: null, pendingInteractions: [],
    capabilities: { history: false, sendMessage: true, steer: false, queueMessage: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
    runtimeInfo: { providerId: 'fixture', sessionId: 'worker', status: 'idle', cwd: directory, connection: { state: 'connected' } },
  };
  const deliveries: Array<{ text: string; delivery: AgentMessageOptions['delivery'] }> = [];
  let acceptance: 'started' | 'queued' | 'handled' = 'handled', lastOptions: AgentMessageOptions | undefined;
  const agents = new Map<string, SessionWireAgent>();
  function agent(id: string): SessionWireAgent {
    let value = agents.get(id);
    if (!value) {
      value = {
        agentId: id,
        snapshot: () => ({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: structuredClone(payload) }),
        subscribe: () => () => {}, async fetchTimeline() { throw new Error('Unexpected history read'); }, async respondToInteraction(requestId) { payload.pendingInteractions = payload.pendingInteractions.filter(request => request.requestId !== requestId); },
        async sendMessage(text, options) { deliveries.push({ text, delivery: options?.delivery }); lastOptions = options; return { disposition: acceptance }; },
      };
      agents.set(id, value);
    }
    return value;
  }
  let state: SavedTeam[] = [], runtime: TeamRuntime, changeOnAdmission: 'connection' | 'route' | undefined, current = true;
  const broker = new TeamBroker({ read: () => state, now: Date.now, assertHost() {}, resolveSession: (_host, _provider, id) => ref(id),
    tasks: { capable: () => true, assertHost() {} }, assistants: { groups: () => [], capable: () => true },
    async change(update) { const draft = structuredClone(state), result = structuredClone(update(draft)); state = draft; return result; },
    async createSeat(_host, seat) { return runtime.create(seat); },
  });
  const access: TeamRuntimeAccess = {
    controllerId: 'controller', available: () => true, supportedProviders: () => ['fixture'], tasks: () => true,
    sessionRouting: { resolve: anchor => ({ anchor, target: anchor, operationIds: [] }), assertCurrent: (anchor, target) => { if (!current || anchor.nativeSessionId !== target.nativeSessionId) throw new Error('Wrong recipient'); } },
    async create() { return 'worker'; }, async acquire(_provider, id) { return { agent: agent(id), release() {} }; },
    execute: createOperationExecutor(cache, 'team-test', { admit: () => { if (changeOnAdmission === 'connection') payload.runtimeInfo.connection = { state: 'reconnecting' }; if (changeOnAdmission === 'route') current = false; } }),
  };
  runtime = new TeamRuntime(directory, access, call => broker.hostCall('host', call), 1000000);
  // A bot's inbox: its main session is the only seat, and what reaches the bot waits there between turns.
  const member = { id: 'bot', hostId: 'host', providerId: 'fixture', nativeSessionId: 'worker', role: 'requester' as const, name: 'Worker', responsibility: '', cwd: directory,
    creation: 'ready' as const, activity: 'idle' as const, summary: '', updatedAt: 1 };
  const source = { hostId: 'host', providerId: 'fixture', nativeSessionId: 'worker', title: 'Work' };
  const message: TeamMessage = { id: 'task', from: member.id, to: member.id, text: 'Read the result while working.', status: 'queued', createdAt: 1 };
  state = [{ id: 'team', operationId: 'inbox', revision: 1, source, title: 'Worker', status: 'active', members: [member], messages: [message], createdAt: 1, updatedAt: 1, inbox: { botId: `b_${'0'.repeat(32)}` } }];
  await runtime.create({ teamId: 'team', source, member: { ...member, creation: 'reserved' }, inbox: { botId: `b_${'0'.repeat(32)}` } });
  const team = state[0]!;
  return { runtime, payload, deliveries, message, recipient: ref('worker'),
    acceptAs(value: typeof acceptance) { acceptance = value; },
    withdrawLast() { lastOptions?.onWithdrawn?.({ reason: 'stopped' }); },
    settle: (outcome: 'rejected') => broker.hostCall('host', { action: 'settle', teamId: team.id, memberId: member.id, messageId: message.id, outcome, error: 'late' }),
    raceAdmission(change: 'connection' | 'route') { changeOnAdmission = change; },
    read: async () => await broker.hostCall('host', { action: 'read', teamId: team.id, memberId: member.id }) as Team & { receipts: TeamMessage[] },
    async close() { await runtime.close(); await cache.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
  };
}

it.each(['interaction without active turn', 'reconnecting', 'unsupported', 'starting', 'closed'] as const)('keeps %s recipients queued without poisoning the later native operation', async blocked => {
  const context = await fixture();
  try {
    if (blocked === 'interaction without active turn') { context.payload.pendingInteractions = [structuredClone(pendingApproval)]; context.payload.activeTurn = null; context.payload.status = 'waiting'; }
    if (blocked === 'reconnecting') context.payload.runtimeInfo.connection = { state: 'reconnecting' };
    if (blocked === 'unsupported') context.payload.capabilities.sendMessage = false;
    if (blocked === 'closed') context.payload.status = 'closed';
    if (blocked === 'starting') context.payload.status = 'starting';
    await context.runtime.tick();
    expect((await context.read()).messages.find(message => message.id === context.message.id)?.status).toBe('queued');
    expect(context.deliveries).toEqual([]);
    context.payload.pendingInteractions = []; context.payload.runtimeInfo.connection = { state: 'connected' };
    context.payload.status = 'idle'; context.payload.activeTurn = null; context.payload.capabilities.sendMessage = true;
    await context.runtime.tick();
    expect((await context.read()).receipts.find(receipt => receipt.id === context.message.id)).toMatchObject({ status: 'accepted', acceptance: 'handled' });
    expect(context.deliveries).toEqual([{ text: expect.stringContaining('Read the result while working.'), delivery: 'immediate' }]);
  } finally { await context.close(); }
}, 5000);

it.each(['running', 'waiting'] as const)('leaves input queued while the bot\'s turn is %s, and delivers between turns without answering its pending interaction', async status => {
  const context = await fixture();
  try {
    context.payload.status = status; context.payload.activeTurn = { turnId: 'active' };
    context.payload.capabilities.steer = true; context.payload.capabilities.queueMessage = true;
    context.payload.pendingInteractions = [structuredClone(pendingApproval)];
    await context.runtime.tick();
    expect(context.deliveries).toEqual([]);
    expect((await context.read()).messages.find(message => message.id === context.message.id)?.status).toBe('queued');
    context.payload.status = 'idle'; context.payload.activeTurn = null; context.payload.pendingInteractions = [];
    await context.runtime.tick();
    expect(context.deliveries).toEqual([{ text: 'Read the result while working.', delivery: 'immediate' }]);
    expect((await context.read()).receipts.find(receipt => receipt.id === context.message.id)).toMatchObject({ status: 'accepted', acceptance: 'handled' });
  } finally { await context.close(); }
}, 5000);

it.each(['connection', 'route'] as const)('settles a claim rejected by a %s change at cache admission instead of leaving an undeliverable queued message', async change => {
  const context = await fixture();
  try {
    context.raceAdmission(change);
    await context.runtime.tick();
    expect(context.deliveries).toEqual([]);
    const result = await context.read();
    expect(result.messages.some(message => message.id === context.message.id)).toBe(false);
    expect(result.receipts.find(receipt => receipt.id === context.message.id)).toMatchObject({ status: 'rejected', resolvedTarget: { nativeSessionId: 'worker' } });
    context.payload.runtimeInfo.connection = { state: 'connected' };
    await context.runtime.tick();
    expect(context.deliveries).toEqual([]);
  } finally { await context.close(); }
}, 5000);

it('reports a queued message withdrawn by stopping its recipient as undelivered and releases the recipient', async () => {
  const context = await fixture();
  try {
    context.acceptAs('queued');
    await context.runtime.tick();
    expect((await context.read()).messages.find(message => message.id === context.message.id)).toMatchObject({ status: 'accepted', acceptance: 'queued' });
    expect(context.runtime.hasUnsettledRecipient(context.recipient)).toBe(true);
    context.withdrawLast();
    await expect.poll(async () => (await context.read()).receipts.find(receipt => receipt.id === context.message.id)?.status).toBe('rejected');
    expect((await context.read()).receipts.find(receipt => receipt.id === context.message.id)).toMatchObject({ error: expect.stringContaining('stopped before this message ran') });
    expect(context.runtime.hasUnsettledRecipient(context.recipient)).toBe(false);
    await context.runtime.tick();
    expect(context.deliveries).toHaveLength(1);
  } finally { await context.close(); }
}, 5000);

it.each(['started', 'handled'] as const)('keeps a message %s by its recipient delivered when a withdrawal arrives late', async disposition => {
  const context = await fixture();
  try {
    context.acceptAs(disposition);
    await context.runtime.tick();
    context.withdrawLast();
    await context.runtime.tick();
    expect((await context.read()).receipts.find(receipt => receipt.id === context.message.id)).toMatchObject({ status: 'accepted', acceptance: disposition });
    await expect(context.settle('rejected')).rejects.toThrow(/already settled/);
  } finally { await context.close(); }
}, 5000);
