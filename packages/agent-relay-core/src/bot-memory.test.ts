import { describe, expect, it } from 'vitest';
import { parseTaskInputs, type BotFact, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import { committed, detached } from './drafts.js';
import type { SavedTeam } from './team-delivery.js';
import { memoryAttachmentStorage, PortableAttachmentStore } from './attachments.js';
import { remembered } from './bot-memory.js';

// Bots call as their own sessions. The groups and the Hosts are stubs; the broker, inboxes and their validation are real.
const botId = (n: number) => 'b_' + n.toString(16).padStart(32, '0');
const names = ['Chief', 'Tracker', 'Reviewer', 'Scribe'];

function fixture(extra = 0) {
  let state: SavedTeam[] = [], now = 100, workers = 0;
  const people = [...names, ...Array.from({ length: extra }, (_, index) => `Helper ${index}`)];
  const members: Record<string, Record<string, unknown>> = Object.fromEntries(people.map((name, index) => [`v${index}`, { botId: botId(index + 1), name }]));
  const group = { window: { id: 'g', title: 'g', revision: 1, views: people.map((_, index) => ({ id: `v${index}`, placement: 'primary',
    binding: { hostId: 'mac', providerId: 'codex', nativeSessionId: `s${index}`, title: `s${index}` } })) }, bots: { rank: 'm', members } } as unknown as WindowGroup;
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => ++now, assertHost: () => {},
    change: async update => { let result: unknown; state = committed.produce(state, draft => { result = structuredClone(detached(update(draft))); }); return result as never; },
    createSeat: async (_hostId, seat) => ({ ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo', ...(seat.member.nativeSessionId ? {} : { nativeSessionId: `worker-${++workers}` }) }),
    attachments: new PortableAttachmentStore(memoryAttachmentStorage()),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => [group], capable: () => true,
      setMemory: async (_groupId, viewId, memory) => { const { memory: _was, ...rest } = members[viewId]!; members[viewId] = { ...rest, ...(memory.length ? { memory } : {}) }; },
      setChief: async (id, chief) => { const [viewId] = Object.entries(members).find(([, details]) => details.botId === id)!; const { chief: _was, ...rest } = members[viewId]!; members[viewId] = { ...rest, ...(chief ? { chief } : {}) }; } },
  });
  const as = (name: string) => ({ providerId: 'codex', nativeSessionId: `s${people.indexOf(name)}` });
  const id = (name: string) => botId(people.indexOf(name) + 1);
  const memoryOf = (name: string) => members[`v${people.indexOf(name)}`]!.memory as BotFact[] | undefined;
  const chiefOf = (name: string) => members[`v${people.indexOf(name)}`]!.chief as string | undefined;
  const inbox = (name: string) => state.find(team => team.inbox?.botId === id(name));
  const texts = (name: string) => inbox(name)?.messages.map(message => message.text) ?? [];
  const person = { setMemory(name: string, memory: BotFact[]) { members[`v${people.indexOf(name)}`]!.memory = memory; } };
  const enable = () => broker.hostCall('mac', { action: 'bot_enablement' }) as Promise<{ bots: Array<{ botId: string; memory?: BotFact[] }> }>;
  return { broker, as, id, memoryOf, chiefOf, texts, inbox, person, enable, members, call: (action: Record<string, unknown>) => broker.hostCall('mac', action as never) };
}
const fact = (n: number): BotFact => ({ id: 'f' + n.toString(16).padStart(8, '0'), text: `Fact ${n}` });

describe('a bot\'s memory', () => {
  it('adds, replaces and forgets facts by id or text, and keeps one fact for the same text', async () => {
    const f = fixture();
    const first = await f.call({ action: 'remember', owner: f.as('Tracker'), text: 'Releases ship on Thursdays.' }) as { fact: BotFact; count: number };
    expect(first).toMatchObject({ fact: { text: 'Releases ship on Thursdays.' }, count: 1 });
    expect(await f.call({ action: 'remember', owner: f.as('Tracker'), text: ' releases ship on  thursdays. ' })).toMatchObject({ fact: first.fact, count: 1 });
    await f.call({ action: 'remember', owner: f.as('Tracker'), text: 'The build takes 9 minutes.' });
    await f.call({ action: 'remember', owner: f.as('Tracker'), text: 'Releases ship on Fridays now.', replace: first.fact.id });
    expect(f.memoryOf('Tracker')!.map(item => item.text)).toEqual(['Releases ship on Fridays now.', 'The build takes 9 minutes.']);
    await f.call({ action: 'remember', owner: f.as('Tracker'), text: 'The build takes 12 minutes.', replace: 'the build takes 9 minutes.' });
    await f.call({ action: 'forget', owner: f.as('Tracker'), fact: first.fact.id });
    expect(f.memoryOf('Tracker')!.map(item => item.text)).toEqual(['The build takes 12 minutes.']);
    await f.call({ action: 'forget', owner: f.as('Tracker'), fact: 'The build takes 12 minutes.' });
    expect(f.memoryOf('Tracker')).toBeUndefined();
    await expect(f.call({ action: 'forget', owner: f.as('Tracker'), fact: 'nothing' })).rejects.toThrow('No fact of yours');
    await expect(f.call({ action: 'remember', owner: f.as('Tracker'), text: 'x', replace: 'nothing' })).rejects.toThrow('No fact of yours');
  });

  it('holds at most 50 facts of at most 300 characters', async () => {
    const f = fixture();
    f.person.setMemory('Tracker', Array.from({ length: 50 }, (_, index) => fact(index)));
    await expect(f.call({ action: 'remember', owner: f.as('Tracker'), text: 'One more.' })).rejects.toThrow('50 facts');
    // Replacing and the same text need no room.
    expect(await f.call({ action: 'remember', owner: f.as('Tracker'), text: 'Fact 7' })).toMatchObject({ count: 50 });
    expect(await f.call({ action: 'remember', owner: f.as('Tracker'), text: 'Fact seven', replace: fact(7).id })).toMatchObject({ count: 50 });
    await f.call({ action: 'forget', owner: f.as('Tracker'), fact: fact(7).id });
    expect(await f.call({ action: 'remember', owner: f.as('Tracker'), text: 'One more.' })).toMatchObject({ count: 50 });
    expect(() => remembered([], '   ')).toThrow('some text');
    // A text longer than a fact is refused where the call is checked.
    await expect(f.call({ action: 'remember', owner: f.as('Tracker'), text: 'x'.repeat(301) })).rejects.toThrow();
  });

  it('writes only the memory of the bot that calls: another bot, a temporary bot and a stranger change nothing', async () => {
    const f = fixture();
    f.person.setMemory('Reviewer', [fact(1)]);
    f.members.v2!.chief = f.id('Chief');
    await f.call({ action: 'remember', owner: f.as('Chief'), text: 'Chief learned this.' });
    await expect(f.call({ action: 'forget', owner: f.as('Chief'), fact: fact(1).id })).rejects.toThrow('No fact of yours');
    await expect(f.call({ action: 'remember', owner: f.as('Chief'), text: 'Not for the reviewer.', replace: fact(1).id })).rejects.toThrow('No fact of yours');
    // Even the chief of a bot cannot name its memory: a call has no target, and the reviewer's facts stay as they were.
    expect(f.memoryOf('Reviewer')).toEqual([fact(1)]);
    expect(f.memoryOf('Chief')!.map(item => item.text)).toEqual(['Chief learned this.']);
    await f.call({ action: 'create_bot', owner: f.as('Chief'), operationId: 'op', name: 'Helper', mission: 'Help.', lifetime: 'temporary' });
    await expect(f.call({ action: 'remember', owner: { providerId: 'codex', nativeSessionId: 'worker-1' }, text: 'Mine.' })).rejects.toThrow('A temporary bot has no memory');
    await expect(f.call({ action: 'remember', owner: { providerId: 'codex', nativeSessionId: 'nobody' }, text: 'Mine.' })).rejects.toThrow('main session');
    expect(f.memoryOf('Reviewer')).toEqual([fact(1)]);
  });

  it('starts every session with the memory: the standing instructions carry it, and a change by the person is resent', async () => {
    const f = fixture();
    f.person.setMemory('Tracker', [{ id: 'f0000000a', text: 'Releases ship on Thursdays.' }]);
    expect((await f.enable()).bots.find(bot => bot.botId === f.id('Tracker'))!.memory).toHaveLength(1);
    const standing = () => f.texts('Tracker').filter(text => text.startsWith('[Your standing instructions'));
    expect(standing()).toHaveLength(1);
    expect(parseTaskInputs(standing()[0]!)![0]).toMatchObject({ kind: 'standing' });
    expect(standing()[0]).toContain('Your memory');
    expect(standing()[0]).toContain('- f0000000a · Releases ship on Thursdays.');
    // The same memory is not sent again; the person's change to it is, with the new fact in it.
    await f.enable();
    expect(standing()).toHaveLength(1);
    f.person.setMemory('Tracker', [{ id: 'f0000000a', text: 'Releases ship on Fridays.' }]);
    await f.enable();
    expect(standing()).toHaveLength(2);
    expect(standing()[1]).toContain('Releases ship on Fridays.');
    // The bot's own write is known to it: nothing is sent back to it, and the mission stays out of the memory section.
    await f.call({ action: 'remember', owner: f.as('Tracker'), text: 'The build takes 9 minutes.' });
    await f.enable();
    expect(standing()).toHaveLength(2);
  });
});

describe('changing a chief', () => {
  const move = (f: ReturnType<typeof fixture>, owner: string, bot: string, chief: string) => f.call({ action: 'set_chief', owner: f.as(owner), bot, chief });
  const told = (f: ReturnType<typeof fixture>, name: string) => f.texts(name).filter(text => text.startsWith('[Chief changed'));

  async function staffOf(f: ReturnType<typeof fixture>, chief: string, ...staff: string[]) { for (const name of staff) f.members[`v${['Chief', 'Tracker', 'Reviewer', 'Scribe'].indexOf(name)}`]!.chief = f.id(chief); }

  it('lets the chief move its staff to another chief, and the old chief, the new chief and the bot are each told', async () => {
    const f = fixture();
    await staffOf(f, 'Chief', 'Tracker');
    expect(await move(f, 'Chief', 'Tracker', 'Reviewer')).toEqual({ bot: 'Tracker', chief: 'Reviewer' });
    expect(f.chiefOf('Tracker')).toBe(f.id('Reviewer'));
    expect(told(f, 'Tracker')).toEqual(['[Chief changed · your chief is now Reviewer (it was Chief)]']);
    expect(told(f, 'Chief')).toEqual(['[Chief changed · "Tracker" is no longer your staff; its chief is now Reviewer]']);
    expect(told(f, 'Reviewer')).toEqual(['[Chief changed · "Tracker" is now your staff (its chief was Chief)]']);
    expect(told(f, 'Scribe')).toEqual([]);
    // A move to the chief it has already is nothing: no one is told again.
    await move(f, 'Reviewer', 'Tracker', 'Reviewer');
    expect(told(f, 'Tracker')).toHaveLength(1);
    // The new chief may hand it on to the person.
    await move(f, 'Reviewer', 'Tracker', 'person');
    expect(f.chiefOf('Tracker')).toBeUndefined();
    expect(told(f, 'Tracker').at(-1)).toBe('[Chief changed · your chief is now the person (it was Reviewer)]');
    expect(told(f, 'Reviewer').at(-1)).toBe('[Chief changed · "Tracker" is no longer your staff; its chief is now the person]');
  });

  it('lets the person move any standing bot, to a chief or to themselves, and tells the bots', async () => {
    const f = fixture();
    await f.broker.chainAction({ action: 'set_chief', botId: f.id('Scribe'), chief: f.id('Chief') });
    expect(f.chiefOf('Scribe')).toBe(f.id('Chief'));
    expect(told(f, 'Scribe')).toEqual(['[Chief changed · your chief is now Chief (it was the person)]']);
    expect(told(f, 'Chief')).toEqual(['[Chief changed · "Scribe" is now your staff (its chief was the person)]']);
    await f.broker.chainAction({ action: 'set_chief', botId: f.id('Scribe'), chief: null });
    expect(f.chiefOf('Scribe')).toBeUndefined();
    expect(told(f, 'Chief')).toHaveLength(2);
    await expect(f.broker.chainAction({ action: 'set_chief', botId: f.id('Scribe'), chief: botId(99) })).rejects.toThrow('No standing bot');
  });

  it('moves only by the person or the bot\'s current chief, and never into a loop', async () => {
    const f = fixture();
    await staffOf(f, 'Chief', 'Tracker');
    await expect(move(f, 'Reviewer', 'Tracker', 'Reviewer')).rejects.toThrow('your own standing staff');
    await expect(move(f, 'Tracker', 'Chief', 'person')).rejects.toThrow('your own standing staff');
    await expect(move(f, 'Chief', 'Tracker', 'Tracker')).rejects.toThrow('its own chief');
    await expect(move(f, 'Chief', 'Tracker', 'Nobody')).rejects.toThrow('another standing bot or the person');
    await staffOf(f, 'Tracker', 'Reviewer');
    await expect(move(f, 'Chief', 'Tracker', 'Reviewer')).rejects.toThrow('its own staff');
    expect(f.chiefOf('Tracker')).toBe(f.id('Chief'));
    expect(told(f, 'Tracker')).toEqual([]);
  });

  it('counts the bot in the new chief\'s span of 12 and refuses a thirteenth', async () => {
    const f = fixture(12);
    for (let index = 0; index < 11; index++) f.members[`v${4 + index}`]!.chief = f.id('Reviewer');
    await staffOf(f, 'Chief', 'Tracker', 'Scribe');
    await move(f, 'Chief', 'Tracker', 'Reviewer');
    expect(f.chiefOf('Tracker')).toBe(f.id('Reviewer'));
    await expect(move(f, 'Chief', 'Scribe', 'Reviewer')).rejects.toThrow('already manages 12 bots');
    await expect(f.broker.chainAction({ action: 'set_chief', botId: f.id('Scribe'), chief: f.id('Reviewer') })).rejects.toThrow('already manages 12 bots');
    expect(f.chiefOf('Scribe')).toBe(f.id('Chief'));
    expect(told(f, 'Scribe')).toEqual([]);
    // The person, as root, has no span: any number of bots move to them.
    await f.broker.chainAction({ action: 'set_chief', botId: f.id('Scribe'), chief: null });
    expect(f.chiefOf('Scribe')).toBeUndefined();
  });
});
