import { describe, expect, it } from 'vitest';
import { CHAIN_LIMIT, CHAIN_RETENTION_MS, parseTaskInputs, type BotChain, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import type { SavedTeam } from './team-delivery.js';
import { BotChains, memoryChains } from './chains.js';
import { chainScope, temporaryBotId } from './chain-scope.js';

// Chains (bots design 7): bots call as their own sessions with the cause of their turn. Groups and Hosts are stubs; the broker, its
// Teams, delivery claims and the chains are real.
const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32) };
const group = () => ({ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'chief'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'mac', providerId: 'claude', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: ids.chief, name: 'Chief' }, v2: { botId: ids.tracker, name: 'Tracker' } } } }) as unknown as WindowGroup;

function fixture() {
  let state: SavedTeam[] = [], now = 1_000, workers = 0;
  const groups = [group()];
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => ++now, assertHost: () => {},
    change: async update => { const draft = structuredClone(state); const result = structuredClone(update(draft)); state = draft; return result; },
    createSeat: async (_, seat) => ({ ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo', ...(seat.member.nativeSessionId ? {} : { nativeSessionId: `worker-${++workers}` }) }),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => groups, capable: () => true },
  });
  const as = (nativeSessionId: string) => ({ providerId: 'claude', nativeSessionId });
  /** The Host hands every queued message of a session to it, as its Controller does between turns. */
  const deliver = async (nativeSessionId: string) => {
    for (const team of state) for (const member of team.members) if (member.nativeSessionId === nativeSessionId)
      for (const message of team.messages.filter(item => item.to === member.id && item.status === 'queued'))
        await broker.hostCall('mac', { action: 'claim', teamId: team.id, memberId: member.id, messageId: message.id, expectedNativeSessionId: nativeSessionId });
  };
  const chain = () => broker.chains.list()[0]!;
  return { broker, as, deliver, chain, state: () => state };
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

  it('counts a created bot, its brief and its report in its organizer\'s chain, and a turn\'s usage', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'c1', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary', cause: person('u1') });
    const task = f.state().find(team => team.task)!, chain = f.chain();
    expect(chain).toMatchObject({ cause: 'person', created: 1, bots: [ids.chief, temporaryBotId(task.id)] });
    expect(task.messages[0]!.chain).toBe(chain.id);
    await f.deliver('worker-1');
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('worker-1'), operationId: 'd1', to: 'organizer', text: 'Looks fine.', status: 'done', cause: framed });
    await f.broker.hostCall('mac', { action: 'chain_turn', owner: f.as('worker-1'), cause: framed, tokens: 1200, costUsd: 0.02 });
    expect(f.broker.chains.list()).toHaveLength(1);
    expect(f.chain()).toMatchObject({ id: chain.id, turns: 1, usage: { tokens: 1200, costUsd: 0.02 } });
    expect(f.broker.chainView().names).toEqual({ [ids.chief]: 'Chief', [temporaryBotId(task.id)]: 'Reviewer' });
    expect(f.state().find(team => team.task)!.messages.at(-1)!.chain).toBe(chain.id);
  });

  it('starts a new chain for each input of the person, and one for a turn with no known cause', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'a', to: 'Tracker', text: 'One.', cause: person('u1') });
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'b', to: 'Tracker', text: 'Two.', cause: person('u2') });
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'c', to: 'Chief', text: 'Three.', cause: framed });
    expect(f.broker.chains.list().map(chain => chain.cause).sort()).toEqual(['bot', 'person', 'person']);
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
