/**
 * The Relay's bot records (bots design 2.1). A group keeps a bot's placement and its `botId`; the record keeps who the bot is. Pages
 * read groups merged with their records (`mergeBots`), and every change to groups is followed by `reconcileBots`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { botIdentity, botPlacement, groupBotViews, isBotRecord, readBotPicture, BOT_IDENTITY_FIELDS, type BotRecord, type WindowBotDetails, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import type { SavedWorkspaceWindow } from './window-workspaces.js';

export type SavedBot = BotRecord & { subject: string };
/** Bot records kept across every account. */
export const MAX_BOTS = 20000;
const key = (windowId: string, viewId: string) => JSON.stringify([windowId, viewId]);

export const newBotId = () => 'b_' + randomUUID().replaceAll('-', '');
/** The id an existing bot gets when its account's bots first move into records: the same on every load, so a restart before the first commit changes nothing. */
export const migrationBotId = (subject: string, windowId: string, viewId: string) =>
  'b_' + createHash('sha256').update(JSON.stringify(['bot', subject, windowId, viewId])).digest('hex').slice(0, 32);

export function validBots(value: unknown): value is SavedBot[] {
  if (!Array.isArray(value) || value.length > MAX_BOTS) return false;
  const ids = new Set<string>();
  return value.every(item => {
    if (!item || typeof item !== 'object' || typeof item.subject !== 'string' || !item.subject) return false;
    const { subject: _, lifetime: __, ...record } = item;
    // A record of an earlier build names a lifetime (standing or temporary); the load drops the field and the temporary records.
    if (__ !== undefined && __ !== 'standing' && __ !== 'temporary' || !isBotRecord(record) || ids.has(record.botId)) return false;
    ids.add(record.botId); return true;
  });
}

/** The group as pages read it: each bot's details with its record's identity. A detail without a record is read as stored. */
export function mergeBots(subject: string, group: WindowGroup, bots: readonly SavedBot[]): WindowGroup {
  if (!group.bots) return group;
  const byId = new Map(bots.filter(bot => bot.subject === subject).map(bot => [bot.botId, bot]));
  return { ...group, bots: { ...group.bots, members: Object.fromEntries(Object.entries(group.bots.members).map(([viewId, details]) => {
    const record = details.botId ? byId.get(details.botId) : undefined;
    return [viewId, record ? { ...botPlacement(details), ...botIdentity(record), ...(record.chief.kind === 'bot' ? { chief: record.chief.botId } : {}) } : details];
  })) } };
}

/** The `botId` of every bot view of an account's live rows, by Window and view, read before a change. */
export function botIdsByView(subject: string, rows: readonly SavedWorkspaceWindow[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const row of rows) if (row.subject === subject && !row.deleted) for (const [viewId, details] of Object.entries(row.bots?.members ?? {})) if (details.botId) ids.set(key(row.id, viewId), details.botId);
  return ids;
}

/**
 * After a change to an account's groups: every bot view of a row the change wrote (`changed`, by id) gets a record (by its `botId`,
 * else the id its view had before the change, else a new one), the record takes the identity its details carry, and the row keeps
 * only placement and the id. Rows the change did not write hold placement only and just keep their bots shown. A standing bot no
 * live row shows is retired; one shown again is brought back.
 */
export function reconcileBots(subject: string, rows: SavedWorkspaceWindow[], bots: SavedBot[], changed: ReadonlySet<string>, before: ReadonlyMap<string, string>, now: number, newId: () => string = newBotId): void {
  const mine = new Map(bots.filter(bot => bot.subject === subject).map(bot => [bot.botId, bot]));
  const taken = new Set(bots.filter(bot => bot.subject !== subject).map(bot => bot.botId));
  const shown = new Set<string>();
  for (const row of rows) {
    if (row.subject !== subject || row.deleted || !row.window || !row.bots) continue;
    const views = new Set(groupBotViews({ window: row.window, bots: row.bots }).map(view => view.id));
    if (!changed.has(row.id)) {
      for (const viewId of views) { const botId = row.bots.members[viewId]?.botId; if (botId && mine.has(botId)) { shown.add(botId); delete mine.get(botId)!.retiredAt; } }
      continue;
    }
    for (const [viewId, details] of Object.entries(row.bots.members)) {
      if (!views.has(viewId)) continue;
      const known = (id: string | undefined) => id && !taken.has(id) && !shown.has(id) ? id : undefined;
      const botId = known(details.botId) ?? known(before.get(key(row.id, viewId))) ?? newId();
      let record = mine.get(botId);
      // The chief is set when the record is made, by the Relay placing a bot another bot created; a later change cannot set it.
      const chief = details.chief && mine.has(details.chief) ? { kind: 'bot' as const, botId: details.chief } : { kind: 'person' as const };
      if (!record) { record = { subject, botId, chief, createdAt: now, updatedAt: now }; bots.push(record); mine.set(botId, record); }
      const identity = botIdentity(details as WindowBotDetails);
      if (BOT_IDENTITY_FIELDS.some(field => JSON.stringify(record![field]) !== JSON.stringify(identity[field]))) {
        for (const field of BOT_IDENTITY_FIELDS) { if (identity[field] === undefined) delete record[field]; else (record as Record<string, unknown>)[field] = identity[field]; }
        record.updatedAt = now;
      }
      if (record.retiredAt !== undefined) delete record.retiredAt;
      row.bots.members[viewId] = { ...botPlacement(details), botId };
      shown.add(botId);
    }
  }
  for (const record of mine.values()) if (!shown.has(record.botId) && record.retiredAt === undefined) record.retiredAt = now;
}

/** Stored bot details with each picture read in the current form; stored rows may hold shapes an older build wrote. Anything that is not bots is returned as it is. */
export function readStoredBots(bots: unknown): unknown {
  const members = (bots as { members?: unknown } | null)?.members;
  if (!members || typeof members !== 'object' || Array.isArray(members)) return bots;
  return { ...(bots as object), members: Object.fromEntries(Object.entries(members).map(([viewId, details]) => {
    if (!details || typeof details !== 'object') return [viewId, details];
    // `mode` was a coordinator or plain switch that a build before one kind of bot (bots design 2.1) stored; it reads as nothing.
    const { mode: _mode, ...kept } = details as { mode?: unknown };
    if (!('picture' in kept)) return [viewId, kept];
    const { picture, ...rest } = kept as { picture: unknown };
    const read = readBotPicture(picture);
    return [viewId, read ? { ...rest, picture: read } : rest];
  })) };
}
const bound = (row: SavedWorkspaceWindow) => row.window && row.bots ? groupBotViews({ window: row.window, bots: row.bots }).map(view => view.id) : [];
/** The bot views of a row whose details have no `botId`, which only state of an earlier build holds: a bot view without details has no record to give. */
const unbound = (row: SavedWorkspaceWindow) => bound(row).filter(viewId => row.bots!.members[viewId] && !row.bots!.members[viewId]!.botId);
/** Whether some live row holds bot details without a record. */
export function needsBotMigration(rows: readonly SavedWorkspaceWindow[]): boolean {
  return rows.some(row => !row.deleted && unbound(row).length > 0);
}
/**
 * Gives every bot with details and no record one, with `migrationBotId`. Pictures are read in the current form first. Only a row that holds
 * such a bot is reconciled, and the identity the row's other bots already have in their records is read into it first, so the
 * reconciliation keeps it.
 */
export function migrateBots(rows: SavedWorkspaceWindow[], bots: SavedBot[], now: number): void {
  for (const row of rows) if (!row.deleted && row.bots) row.bots = readStoredBots(row.bots) as typeof row.bots;
  for (const subject of new Set(rows.map(row => row.subject))) {
    const before = new Map<string, string>(), changed = new Set<string>();
    for (const row of rows) {
      if (row.subject !== subject || row.deleted || !row.window || !row.bots || !unbound(row).length) continue;
      row.bots = mergeBots(subject, { window: row.window, bots: row.bots }, bots).bots!;
      for (const viewId of bound(row)) before.set(key(row.id, viewId), migrationBotId(subject, row.id, viewId));
      changed.add(row.id);
    }
    reconcileBots(subject, rows, bots, changed, before, now);
  }
}

/** Whether some record still names a lifetime: an earlier build's. */
export const hasLegacyBotLifetime = (bots: readonly object[] | undefined): boolean => !!bots?.some(bot => Object.hasOwn(bot, 'lifetime'));
/** Drops the records of temporary bots, which are sub-sessions now, and the lifetime of every other: they were standing. Dropped, not converted. */
export function dropLegacyBotLifetime(bots: Array<SavedBot & { lifetime?: string }>): Array<SavedBot> {
  return bots.filter(bot => bot.lifetime !== 'temporary').map(({ lifetime: _lifetime, ...record }) => record);
}
