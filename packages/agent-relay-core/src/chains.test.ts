import { describe, expect, it } from 'vitest';
import { CHAIN_APPROVAL_LIMIT, CHAIN_LIMIT, CHAIN_RETENTION_MS, parseTaskInputs, type BotChain, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import { committed, detached } from './drafts.js';
import type { SavedTeam } from './team-delivery.js';
import { BotChains, memoryChains } from './chains.js';
import { chainScope } from './chain-scope.js';

// Chains (bots design 7): bots call as their own sessions with the cause of their turn. Groups and Hosts are stubs; the broker, its
// Teams, delivery claims and the chains are real.
const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32) };
const group = () => ({ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'chief'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'mac', providerId: 'claude', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: ids.chief, name: 'Chief' }, v2: { botId: ids.tracker, name: 'Tracker' } } } }) as unknown as WindowGroup;

function fixture() {
  let state: SavedTeam[] = [], now = 1_000, workers = 0;
  const groups = [group()], alerts: Array<{ session: string; identity: string }> = [];
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => ++now, assertHost: () => {},
    // Drafts as the Relay's state makes them.
    change: async update => { let result: unknown; state = committed.produce(state, draft => { result = structuredClone(detached(update(draft))); }); return result as never; },
    createSeat: async (_, seat) => ({ ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo', ...(seat.member.nativeSessionId ? {} : { nativeSessionId: `worker-${++workers}` }) }),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => groups, capable: () => true },
    alertChain: (session, identity) => { alerts.push({ session: session.nativeSessionId, identity }); },
  });
  const as = (nativeSessionId: string) => ({ providerId: 'claude', nativeSessionId });
  /** The Host hands every queued message of a session to it, as its Controller does between turns. */
  const deliver = async (nativeSessionId: string) => {
    for (const team of state) for (const member of team.members) if (member.nativeSessionId === nativeSessionId)
      for (const message of team.messages.filter(item => item.to === member.id && item.status === 'queued'))
        await broker.hostCall('mac', { action: 'claim', teamId: team.id, memberId: member.id, messageId: message.id, expectedNativeSessionId: nativeSessionId });
  };
  const chain = () => broker.chains.list()[0]!;
  return { broker, as, deliver, chain, alerts, groups, state: () => state, advance: (ms: number) => { now += ms; } };
}
const person = (messageId: string) => ({ kind: 'person' as const, messageId });
const framed = { kind: 'framed' as const };

describe('chains', () => {
  it('follows the person\'s input through messages and replies: one chain, its bots, messages and depth, and no limit on replies', async () => {
    const f = fixture();
    let sent = await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'o1', to: 'Tracker', text: 'Is the build green?', cause: person('u1') }) as { messageId: string };
    const id = f.chain().id;
    expect(f.chain()).toMatchObject({ cause: 'person', bot: ids.chief, bots: [ids.chief, ids.tracker], messages: 1, depth: 1 });
    for (let turn = 0; turn < 8; turn++) {
      const [from, to, name] = turn % 2 ? ['chief', 'tracker', 'Tracker'] : ['tracker', 'chief', 'Chief'];
      await f.deliver(from);
      sent = await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as(from), operationId: `r${turn}`, to: name, text: `Reply ${turn}`, replyTo: sent.messageId, cause: framed }) as { messageId: string };
      void to;
    }
    expect(f.broker.chains.list()).toHaveLength(1);
    expect(f.chain()).toMatchObject({ id, messages: 9, depth: 9, bots: [ids.chief, ids.tracker] });
    // Every message between the bots carries the chain; their standing instructions are the system's.
    const between = f.state().flatMap(team => team.messages).filter(message => parseTaskInputs(message.text)?.[0]?.kind === 'assistant');
    expect(between).toHaveLength(9);
    expect(between.every(message => message.chain === id)).toBe(true);
  });

  it('counts a started sub-session, its first work and its result in its bot\'s chain, and a turn\'s usage', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'c1', name: 'Reviewer', prompt: 'Review it.', cause: person('u1') });
    const task = f.state().find(team => team.task)!, chain = f.chain();
    // A sub-session is no bot: the chain counts it apart and names only bots.
    expect(chain).toMatchObject({ cause: 'person', created: 0, subSessions: 1, bots: [ids.chief] });
    expect(task.messages[0]!.chain).toBe(chain.id);
    await f.deliver('worker-1');
    await f.broker.hostCall('mac', { action: 'chain_turn', owner: f.as('worker-1'), cause: framed, tokens: 1200, costUsd: 0.02 }).catch(() => undefined);
    expect(f.broker.chains.list()).toHaveLength(1);
    expect(f.broker.chainView().names).toEqual({ [ids.chief]: 'Chief' });
  });

  it('settles a delivered message of a chain, which leaves the inbox for the next one', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'a', to: 'Tracker', text: 'One.', cause: person('u1') });
    await f.deliver('tracker');
    const inbox = () => f.state().find(team => team.inbox?.botId === ids.tracker)!;
    for (const message of inbox().messages.filter(item => item.status === 'dispatching'))
      await f.broker.hostCall('mac', { action: 'settle', teamId: inbox().id, memberId: inbox().members[0]!.id, messageId: message.id, outcome: 'accepted', acceptance: 'started',
        resolvedTarget: message.resolvedTarget! });
    expect(inbox().messages).toEqual([]);
    expect(inbox().deliveryReceipts!.every(receipt => !('chain' in receipt))).toBe(true);
    expect(inbox().members[0]!.chain?.id).toBe(f.chain().id);
  });

  it('starts a new chain for each input of the person, and one for a turn with no known cause', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'a', to: 'Tracker', text: 'One.', cause: person('u1') });
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'b', to: 'Tracker', text: 'Two.', cause: person('u2') });
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'c', to: 'Chief', text: 'Three.', cause: framed });
    expect(f.broker.chains.list().map(chain => chain.cause).sort()).toEqual(['bot', 'person', 'person']);
  });
});

describe('the audit', () => {
  it('stops a chain: its waiting messages are withdrawn, its turns (a sub-session\'s too) interrupted, and a later call in it refused', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'c1', name: 'Reviewer', prompt: 'Review it.', cause: person('u1') });
    await f.deliver('worker-1');
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'm1', to: 'Tracker', text: 'Hold the build.', cause: person('u1') });
    const id = f.chain().id;
    expect(await f.broker.chainAction({ action: 'stop', chainId: id })).toMatchObject({ withdrawn: 1, stopped: 1 });
    const task = f.state().find(team => team.task)!, tracker = f.state().find(team => team.inbox?.botId === ids.tracker)!;
    // The sub-session stays, with its context; only its turn is asked to stop.
    expect(task.task!.state).toBe('working');
    expect(task.members[0]!.interrupt).toBeGreaterThan(0);
    expect(tracker.messages.filter(message => message.chain === id && message.status === 'queued')).toEqual([]);
    expect(f.chain().stopped).toBeGreaterThan(0);
    await expect(f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'm2', to: 'Tracker', text: 'Go on.', cause: person('u1') })).resolves.toMatchObject({ outcome: 'forbidden', reason: expect.stringContaining('The person stopped this work') });
    // The person's next input is a new chain.
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'm3', to: 'Tracker', text: 'New request.', cause: person('u2') });
    expect(f.broker.chains.list()).toHaveLength(2);
  });

  it('stops one bot\'s part of a chain and leaves the rest running', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'c1', name: 'Reviewer', prompt: 'Review it.', cause: person('u1') });
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'm1', to: 'Tracker', text: 'Hold the build.', cause: person('u1') });
    await f.deliver('tracker');
    const id = f.chain().id;
    await f.broker.chainAction({ action: 'stop_bot', chainId: id, botId: ids.tracker });
    expect(f.state().find(team => team.inbox?.botId === ids.tracker)!.members[0]!.interrupt).toBeGreaterThan(0);
    expect(f.state().find(team => team.task)!.task!.state).toBe('working');
    await expect(f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 't1', to: 'Chief', text: 'Holding.', cause: framed })).resolves.toMatchObject({ outcome: 'forbidden' });
    expect(await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'm2', to: 'Reviewer', text: 'Also the notes.', cause: person('u1') })).toBeDefined();
    expect(f.chain().stoppedBots).toEqual([ids.tracker]);
  });

  it('holds a paused bot\'s messages until it is resumed, and refuses to pause what is no standing bot', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'm1', to: 'Tracker', text: 'Hold the build.', cause: person('u1') });
    expect(await f.broker.chainAction({ action: 'pause_bot', botId: ids.tracker })).toEqual({ botId: ids.tracker, state: 'paused' });
    const polled = () => (f.broker.hostCall('mac', { action: 'poll' }) as Promise<Array<{ inbox?: { botId: string }; messages: unknown[] }>>).then(teams => teams.find(team => team.inbox?.botId === ids.tracker)?.messages.length);
    expect(await polled()).toBe(0);
    expect(f.broker.chainView().paused).toEqual([ids.tracker]);
    await f.broker.chainAction({ action: 'resume_bot', botId: ids.tracker });
    expect(await polled()).toBeGreaterThan(0);
    await expect(f.broker.chainAction({ action: 'retire_bot', botId: ids.tracker } as never)).rejects.toThrow();
  });
});

describe('thresholds that notify', () => {
  it('tells the person once for each threshold a chain passes, as a reminder for its first bot, and stops nothing', async () => {
    const f = fixture();
    await f.broker.chainAction({ action: 'set_thresholds', thresholds: { tokens: 1000, depth: 2, minutes: 30 } });
    let sent = await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'o1', to: 'Tracker', text: 'Status?', cause: person('u1') }) as { messageId: string };
    const id = f.chain().id;
    expect(f.alerts).toEqual([]);
    await f.broker.hostCall('mac', { action: 'chain_turn', owner: f.as('chief'), cause: person('u1'), tokens: 1500 });
    await f.deliver('tracker');
    sent = await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'r1', to: 'Chief', text: 'Green.', replyTo: sent.messageId, cause: framed }) as { messageId: string };
    await f.broker.hostCall('mac', { action: 'chain_turn', owner: f.as('chief'), cause: person('u1'), tokens: 10 });
    f.advance(31 * 60_000);
    await f.broker.hostCall('mac', { action: 'chain_turn', owner: f.as('chief'), cause: person('u1'), tokens: 10 });
    expect(f.alerts).toEqual(['tokens', 'depth', 'minutes'].map(item => ({ session: 'chief', identity: `chain:${id}:${item}` })));
    expect(f.chain()).toMatchObject({ passed: ['tokens', 'depth', 'minutes'] });
    expect(f.chain().stopped).toBeUndefined();
    expect(f.broker.chainView().thresholds).toEqual({ tokens: 1000, depth: 2, minutes: 30 });
  });
  it('reminds through the latest bot of a chain still there when the bot that started it is gone', async () => {
    const f = fixture();
    await f.broker.chainAction({ action: 'set_thresholds', thresholds: { tokens: 1000 } });
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'o1', to: 'Tracker', text: 'Status?', cause: person('u1') });
    const id = f.chain().id;
    await f.deliver('tracker');
    // The person removes Chief from its group: the chain's first bot has no session any more.
    const [only] = f.groups, members = (only!.bots as { members: Record<string, unknown> }).members;
    (only!.window as { views: Array<{ id: string }> }).views = only!.window.views.filter(view => view.id !== 'v1'); delete members.v1;
    // Tracker's turn on Chief's message passes the threshold.
    await f.broker.hostCall('mac', { action: 'chain_turn', owner: f.as('tracker'), cause: framed, tokens: 1500 });
    expect(f.chain()).toMatchObject({ id, passed: ['tokens'] });
    expect(f.alerts).toEqual([{ session: 'tracker', identity: `chain:${id}:tokens` }]);
  });
});

describe('the chains an account keeps', () => {
  it('keeps the latest hundred, and none older than its retention', async () => {
    let now = 0;
    const chains = new BotChains(memoryChains(), () => now, () => false);
    const start = { cause: 'person' as const, bot: ids.chief };
    const id = (n: number) => `c_${n.toString(16).padStart(16, '0')}`;
    const add = async (n: number) => { const scope = chainScope(id(n)); scope.messages = 1; await chains.record(scope, start); };
    await add(0);
    now = CHAIN_RETENTION_MS + 1;
    for (let n = 1; n <= CHAIN_LIMIT + 1; n++) { now++; await add(n); }
    const kept = chains.list().map((chain: BotChain) => chain.id);
    expect(kept).toHaveLength(CHAIN_LIMIT);
    expect(kept).not.toContain(id(0));
    expect(kept).not.toContain(id(1));
    expect(kept[0]).toBe(id(CHAIN_LIMIT + 1));
  });
});

describe('standing approvals the person gave a chain (bots plan 9d)', () => {
  const ask = (f: ReturnType<typeof fixture>, session: string, cause: ReturnType<typeof person> | typeof framed, cwd = '/repo', grant?: true) =>
    f.broker.hostCall('mac', { action: 'chain_approval', owner: f.as(session), cause, cwd, ...(grant ? { grant } : {}) });

  it('records the person\'s choice in the chain, answers any tool use in the same folder for every bot of the chain, and counts each use', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'm1', to: 'Tracker', text: 'Fix the build.', cause: person('u1') });
    await f.deliver('tracker');
    expect(await ask(f, 'chief', person('u1'))).toEqual({ allowed: false });
    await ask(f, 'chief', person('u1'), '/repo', true);
    expect(f.chain().approvals).toEqual([{ cwd: '/repo', at: expect.any(Number), applied: 0 }]);
    // Tracker works in the chain on Chief's message, as framed input.
    expect(await ask(f, 'tracker', framed)).toEqual({ allowed: true });
    expect(await ask(f, 'chief', person('u1'))).toEqual({ allowed: true });
    expect(f.chain().approvals![0]!.applied).toBe(2);
    expect(f.broker.chainView().chains[0]!.approvals).toHaveLength(1);
    await ask(f, 'chief', person('u1'), '/repo', true);
    expect(f.chain().approvals).toHaveLength(1);
  });

  it('asks again for another folder and another chain', async () => {
    const f = fixture();
    await ask(f, 'chief', person('u1'), '/repo', true);
    expect(await ask(f, 'chief', person('u1'), '/other')).toEqual({ allowed: false });
    expect(await ask(f, 'chief', person('u2'))).toEqual({ allowed: false });
    expect(await ask(f, 'tracker', framed)).toEqual({ allowed: false });
    expect(f.chain().approvals![0]!.applied).toBe(0);
  });

  it('ends when the person revokes it, stops the chain or stops the bot, and with the chain\'s retention', async () => {
    const f = fixture();
    await ask(f, 'chief', person('u1'), '/repo', true);
    await ask(f, 'chief', person('u1'), '/other', true);
    const id = f.chain().id;
    await f.broker.chainAction({ action: 'revoke_approval', chainId: id, cwd: '/repo' });
    expect(await ask(f, 'chief', person('u1'))).toEqual({ allowed: false });
    expect(await ask(f, 'chief', person('u1'), '/other')).toEqual({ allowed: true });
    await expect(f.broker.chainAction({ action: 'revoke_approval', chainId: id, cwd: '/repo' })).rejects.toThrow('not standing');
    await f.broker.chainAction({ action: 'stop_bot', chainId: id, botId: ids.chief });
    expect(await ask(f, 'chief', person('u1'), '/other')).toEqual({ allowed: false });
    const other = fixture();
    await ask(other, 'chief', person('u1'), '/repo', true);
    await other.broker.chainAction({ action: 'stop', chainId: other.chain().id });
    expect(await ask(other, 'chief', person('u1'))).toEqual({ allowed: false });

    let now = 0;
    const chains = new BotChains(memoryChains(), () => now, () => false), start = { cause: 'person' as const, bot: ids.chief }, first = 'c_' + '1'.repeat(16);
    await chains.approve(first, start, '/repo');
    expect(await chains.covers(first, ids.chief, '/repo')).toBe(true);
    now = CHAIN_RETENTION_MS + 1;
    const scope = chainScope('c_' + '2'.repeat(16)); scope.messages = 1; await chains.record(scope, start);
    expect(await chains.covers(first, ids.chief, '/repo')).toBe(false);
  });

  it('holds a limited number of standing approvals in one chain', async () => {
    const f = fixture();
    for (let n = 0; n < CHAIN_APPROVAL_LIMIT; n++) await ask(f, 'chief', person('u1'), `/repo${n}`, true);
    await expect(ask(f, 'chief', person('u1'), '/one-more', true)).rejects.toThrow('most standing approvals');
  });
});
