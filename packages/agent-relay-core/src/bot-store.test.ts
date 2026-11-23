import { describe, expect, it } from 'vitest';
import type { WindowGroup } from '@orchardworks/agent-remote-protocol';
import { mergeBots, migrateBots, migrationBotId, needsBotMigration, reconcileBots, validBots, type SavedBot } from './bot-store.js';
import type { SavedWorkspaceWindow } from './window-workspaces.js';

const view = (id: string, nativeSessionId: string) => ({ id, placement: 'primary', binding: { hostId: 'mac', providerId: 'claude', nativeSessionId, title: nativeSessionId } });
const row = (id: string, members: Record<string, Record<string, unknown>>): SavedWorkspaceWindow => ({ subject: 'me', id, generation: 0, receipts: [],
  window: { id, title: id, revision: 1, views: Object.keys(members).map((viewId, index) => view(viewId, `${id}-${index}`)), selectedViewId: null, selectedPrimaryViewId: null } as never,
  bots: { rank: 'm', members: members as never } });
let next = 0;
const all = (rows: SavedWorkspaceWindow[]) => new Set(rows.map(row => row.id));
const newId = () => 'b_' + (++next).toString(16).padStart(32, '0');

describe('the bot store', () => {
  it('creates a record for a new bot view, keeps identity there and placement with the group', () => {
    const rows = [row('g1', { v1: { name: 'Chief', label: 'Lead', mission: 'Coordinate.', pinned: true } })], bots: SavedBot[] = [];
    reconcileBots('me', rows, bots, all(rows), new Map(), 10, newId);
    const botId = rows[0]!.bots!.members.v1!.botId!;
    expect(rows[0]!.bots!.members.v1).toEqual({ botId, pinned: true });
    expect(bots).toEqual([{ subject: 'me', botId, name: 'Chief', label: 'Lead', mission: 'Coordinate.', organizer: { kind: 'person' }, lifetime: 'standing', createdAt: 10, updatedAt: 10 }]);
    expect(mergeBots('me', { window: rows[0]!.window!, bots: rows[0]!.bots } as WindowGroup, bots).bots!.members.v1).toEqual({ botId, pinned: true, name: 'Chief', label: 'Lead', mission: 'Coordinate.' });
  });

  it('keeps a bot through a change that leaves its id out, by its view, and through a move to another group, by its id', () => {
    const rows = [row('g1', { v1: { name: 'Chief' } }), row('g2', { v9: { name: 'Other' } })], bots: SavedBot[] = [];
    reconcileBots('me', rows, bots, all(rows), new Map(), 10, newId);
    const chief = rows[0]!.bots!.members.v1!.botId!;
    const before = new Map([[JSON.stringify(['g1', 'v1']), chief]]);
    rows[0]!.bots!.members.v1 = { name: 'Chief 2' };
    reconcileBots('me', rows, bots, all(rows), before, 11, newId);
    expect(rows[0]!.bots!.members.v1!.botId).toBe(chief);
    // The bot moves to g2 with its id, as a transfer carries its details.
    rows[1]!.window!.views.push(view('v1', 'moved') as never); rows[1]!.bots!.members.v1 = { botId: chief, name: 'Chief 2' };
    rows[0]!.window!.views.splice(0, 1); delete rows[0]!.bots!.members.v1;
    reconcileBots('me', rows, bots, all(rows), new Map(), 12, newId);
    expect(bots.find(bot => bot.botId === chief)).toMatchObject({ name: 'Chief 2', updatedAt: 11 });
    expect(bots.find(bot => bot.botId === chief)!.retiredAt).toBeUndefined();
  });

  it('leaves the identity of bots in rows a change did not write', () => {
    const rows = [row('g1', { v1: { name: 'Chief' } }), row('g2', { v2: { name: 'Other' } })], bots: SavedBot[] = [];
    reconcileBots('me', rows, bots, all(rows), new Map(), 10, newId);
    // g1 is stored with placement only; a change to g2 alone must not read its missing name as cleared.
    rows[1]!.bots!.members.v2 = { ...rows[1]!.bots!.members.v2, name: 'Other 2' };
    reconcileBots('me', rows, bots, new Set(['g2']), new Map(), 11, newId);
    expect(bots.map(bot => bot.name)).toEqual(['Chief', 'Other 2']);
    expect(bots.every(bot => bot.retiredAt === undefined)).toBe(true);
  });

  it('retires a standing bot no live group shows, and brings it back when one shows it again', () => {
    const rows = [row('g1', { v1: { name: 'Chief' } })], bots: SavedBot[] = [];
    reconcileBots('me', rows, bots, all(rows), new Map(), 10, newId);
    const chief = rows[0]!.bots!.members.v1!.botId!;
    const removed = rows[0]!.bots!.members.v1!;
    delete rows[0]!.bots!.members.v1;
    reconcileBots('me', rows, bots, all(rows), new Map(), 20, newId);
    expect(bots[0]).toMatchObject({ botId: chief, retiredAt: 20 });
    rows[0]!.bots!.members.v1 = removed;
    reconcileBots('me', rows, bots, all(rows), new Map(), 30, newId);
    expect(bots[0]!.retiredAt).toBeUndefined();
  });

  it('never touches another account, and refuses an id another account holds', () => {
    const bots: SavedBot[] = [{ subject: 'other', botId: newId(), organizer: { kind: 'person' }, lifetime: 'standing', createdAt: 1, updatedAt: 1 }];
    const rows = [row('g1', { v1: { botId: bots[0]!.botId, name: 'Mine' } })];
    reconcileBots('me', rows, bots, all(rows), new Map(), 10, newId);
    expect(rows[0]!.bots!.members.v1!.botId).not.toBe(bots[0]!.botId);
    expect(bots.filter(bot => bot.subject === 'other')).toEqual([{ subject: 'other', botId: bots[0]!.botId, organizer: { kind: 'person' }, lifetime: 'standing', createdAt: 1, updatedAt: 1 }]);
  });

  it('derives the same id for an existing bot on every load, and validates stored records', () => {
    expect(migrationBotId('me', 'g1', 'v1')).toBe(migrationBotId('me', 'g1', 'v1'));
    expect(migrationBotId('me', 'g1', 'v1')).toMatch(/^b_[0-9a-f]{32}$/);
    const record = { subject: 'me', botId: newId(), organizer: { kind: 'person' }, lifetime: 'standing', createdAt: 1, updatedAt: 1 };
    expect(validBots([record])).toBe(true);
    expect(validBots([record, record])).toBe(false);
    expect(validBots([{ ...record, subject: '' }])).toBe(false);
  });
});


describe('moving existing bots into records', () => {
  it('gives every existing bot view a record with an id derived from its place, once', () => {
    const rows = [row('g1', { v1: { name: 'Chief', picture: { shape: 'rounded', color: '#ff8a3d' }, pinned: true } })];
    expect(needsBotMigration(rows)).toBe(true);
    const bots: SavedBot[] = [];
    migrateBots(rows, bots, 5);
    expect(rows[0]!.bots!.members.v1).toEqual({ botId: migrationBotId('me', 'g1', 'v1'), pinned: true });
    // An older picture shape reads in the current form before it moves.
    expect(bots).toEqual([expect.objectContaining({ botId: migrationBotId('me', 'g1', 'v1'), name: 'Chief', picture: { shape: 'squircle', color: '#ff8a3d' } })]);
    expect(needsBotMigration(rows)).toBe(false);
  });
});
