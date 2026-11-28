import { describe, expect, it } from 'vitest';
import { PAGES_PER_BOT, isTeam, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import type { SavedTeam } from './team-delivery.js';
import { committed, detached } from './drafts.js';

// A standing bot's pages and the primary bot. Groups and Hosts are stubs; the broker, inboxes and pages are real.
const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32), scout: 'b_' + '3'.repeat(32) };
const group = () => ({ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'chief'], ['v2', 'tracker'], ['v3', 'scout']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'mac', providerId: 'claude', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: ids.chief, name: 'Chief' }, v2: { botId: ids.tracker, name: 'Tracker', chief: ids.chief }, v3: { botId: ids.scout, name: 'Scout' } } } }) as unknown as WindowGroup;

function fixture() {
  let state: SavedTeam[] = [], now = 1_000_000;
  const groups = [group()];
  const marks: Array<[string, boolean]> = [];
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => now, assertHost: () => {},
    change: async update => { let result: unknown; state = committed.produce(state, draft => { result = structuredClone(detached(update(draft))); }); return result as never; },
    createSeat: async (_, seat) => ({ ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo', nativeSessionId: seat.member.nativeSessionId ?? 'worker' }),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => groups, capable: () => true,
      // The Relay's one write: at most one bot is primary.
      setPrimary: async (botId, primary) => {
        marks.push([botId, primary]);
        for (const [, details] of Object.entries(groups[0]!.bots!.members)) { if (details.botId === botId && primary) details.primary = true; else delete details.primary; }
      } },
  });
  const as = (nativeSessionId: string) => ({ providerId: 'claude', nativeSessionId });
  const call = (who: string, action: Record<string, unknown>) => broker.hostCall('mac', { ...action, owner: as(who) } as never) as Promise<any>;
  const inbox = (botId: string) => state.find(team => team.inbox?.botId === botId)!;
  const texts = (botId: string) => inbox(botId).messages.map(message => message.text);
  return { broker, call, inbox, texts, marks, advance: (ms: number) => { now += ms; } };
}

describe('a bot\'s pages', () => {
  it('keeps a page on its inbox, rewritten whole, with a version that counts the rewrites that changed it', async () => {
    const f = fixture();
    const made = await f.call('chief', { action: 'write_page', title: 'Notes', contents: '| a |\n|---|\n| 1 |' });
    expect(made).toMatchObject({ pageId: expect.stringMatching(/^pg_[0-9a-f]{12}$/), version: 1, message: 'Page created.' });
    expect(isTeam(f.inbox(ids.chief))).toBe(true);
    f.advance(5000);
    expect(await f.call('chief', { action: 'write_page', pageId: made.pageId, title: 'Notes', contents: 'later' })).toMatchObject({ pageId: made.pageId, version: 2, message: 'Page rewritten.' });
    f.advance(5000);
    // Writing what is there changes nothing: the version and the time stay.
    expect((await f.call('chief', { action: 'write_page', pageId: made.pageId, title: 'Notes', contents: 'later' })).version).toBe(2);
    expect(f.inbox(ids.chief).inbox!.pages).toEqual([{ pageId: made.pageId, title: 'Notes', contents: 'later', version: 2, updatedAt: 1_005_000 }]);
    await expect(f.call('chief', { action: 'write_page', pageId: 'pg_000000000000', title: 'x', contents: 'y' })).rejects.toThrow('You have no page pg_000000000000');
  });

  it('is read by id with its contents, or listed without them, by the bot and by every other bot of the account', async () => {
    const f = fixture();
    const first = await f.call('chief', { action: 'write_page', title: 'Plan', contents: 'The plan.' });
    f.advance(1000);
    const second = await f.call('chief', { action: 'write_page', title: 'Log', contents: 'The log.' });
    expect((await f.call('chief', { action: 'read_page' })).pages.map((page: { pageId: string }) => page.pageId)).toEqual([second.pageId, first.pageId]);
    expect((await f.call('chief', { action: 'read_page' })).pages[0]).not.toHaveProperty('contents');
    // A bot that is not its chief reads it too; the name or the id names the bot.
    expect(await f.call('scout', { action: 'read_page', bot: 'Chief', pageId: first.pageId })).toMatchObject({ bot: 'Chief', title: 'Plan', contents: 'The plan.', version: 1 });
    expect((await f.call('scout', { action: 'read_page', bot: ids.chief })).pages).toHaveLength(2);
    await expect(f.call('scout', { action: 'read_page', bot: 'Nobody' })).rejects.toThrow('No bot of this account answers to that name');
    await expect(f.call('scout', { action: 'read_page', bot: 'Chief', pageId: 'pg_000000000000' })).rejects.toThrow('Chief has no page');
  });

  it('is written by its own bot alone: a write names no other bot, and it lands on the caller\'s inbox', async () => {
    const f = fixture();
    await f.call('tracker', { action: 'write_page', title: 'Tracker', contents: 'Tasks.' });
    expect(f.inbox(ids.tracker).inbox!.pages).toHaveLength(1);
    expect(f.inbox(ids.chief)?.inbox?.pages).toBeUndefined();
    expect(await f.call('chief', { action: 'read_page' })).toEqual({ bot: 'Chief', pages: [] });
  });

  it('keeps at most ten pages of a bot and one team page, the mark moving to the page marked last', async () => {
    const f = fixture();
    const written: string[] = [];
    for (let index = 0; index < PAGES_PER_BOT; index++) written.push((await f.call('chief', { action: 'write_page', title: `Page ${index}`, contents: 'x' })).pageId);
    await expect(f.call('chief', { action: 'write_page', title: 'One more', contents: 'x' })).rejects.toThrow('You keep 10 pages at most');
    // Rewriting an existing page is still allowed at the limit.
    await f.call('chief', { action: 'write_page', pageId: written[0], title: 'Page 0', contents: 'again' });
    expect(await f.call('chief', { action: 'write_page', pageId: written[1], title: 'Page 1', contents: 'team', team: true })).toMatchObject({ version: 2, message: expect.stringContaining('team page') });
    await f.call('chief', { action: 'write_page', pageId: written[2], title: 'Page 2', contents: 'x', team: true });
    expect(f.inbox(ids.chief).inbox!.pages!.filter(page => page.team).map(page => page.pageId)).toEqual([written[2]]);
  });
});

describe('the primary bot', () => {
  it('is marked by the person for a bot that reports to them, replacing the one before, and lists as primary', async () => {
    const f = fixture();
    expect(await f.broker.chainAction({ action: 'set_primary', botId: ids.scout, primary: true })).toEqual({ botId: ids.scout, primary: true });
    expect((await f.call('chief', { action: 'list_bots' })).bots.find((bot: { id: string }) => bot.id === ids.scout)).toMatchObject({ primary: true });
    await f.broker.chainAction({ action: 'set_primary', botId: ids.chief, primary: true });
    expect(f.marks).toEqual([[ids.scout, true], [ids.chief, true]]);
    expect((await f.call('scout', { action: 'list_bots' })).bots.map((bot: { id: string; primary?: true }) => [bot.id, bot.primary])).toEqual([[ids.chief, true], [ids.tracker, undefined]]);
  });

  it('is refused for a bot that reports to another bot, and for a bot that is gone', async () => {
    const f = fixture();
    await expect(f.broker.chainAction({ action: 'set_primary', botId: ids.tracker, primary: true })).rejects.toThrow('Only a bot that reports to you can be primary.');
    await expect(f.broker.chainAction({ action: 'set_primary', botId: 'b_' + '9'.repeat(32), primary: true })).rejects.toThrow('No standing bot of this account has that id.');
    expect(f.marks).toEqual([]);
  });

  it('is sent its primary section as new standing instructions, which the next change of role replaces', async () => {
    const f = fixture();
    await f.broker.chainAction({ action: 'set_primary', botId: ids.chief, primary: true });
    expect(f.texts(ids.chief).at(-1)).toContain('You are the person\'s primary bot');
    await f.broker.chainAction({ action: 'set_primary', botId: ids.scout, primary: true });
    // The bot that lost the mark is told its instructions again, without the section.
    expect(f.texts(ids.chief)).toHaveLength(2);
    expect(f.texts(ids.chief).at(-1)).toMatch(/^\[Your standing instructions · v\d+\]/);
    expect(f.texts(ids.chief).at(-1)).not.toContain('primary bot');
    expect(f.texts(ids.scout).at(-1)).toContain('You are the person\'s primary bot');
    // Setting what is set sends nothing more.
    await f.broker.chainAction({ action: 'set_primary', botId: ids.scout, primary: true });
    expect(f.texts(ids.scout)).toHaveLength(1);
  });
});
