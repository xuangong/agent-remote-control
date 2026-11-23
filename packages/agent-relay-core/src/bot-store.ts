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
    const { subject: _, ...record } = item;
    if (!isBotRecord(record) || ids.has(record.botId)) return false;
    ids.add(record.botId); return true;
  });
}

/** The group as pages read it: each bot's details with its record's identity. A detail without a record is read as stored. */
export function mergeBots(subject: string, group: WindowGroup, bots: readonly SavedBot[]): WindowGroup {
  if (!group.bots) return group;
  const byId = new Map(bots.filter(bot => bot.subject === subject).map(bot => [bot.botId, bot]));
  return { ...group, bots: { ...group.bots, members: Object.fromEntries(Object.entries(group.bots.members).map(([viewId, details]) => {
    const record = details.botId ? byId.get(details.botId) : undefined;
    return [viewId, record ? { ...botPlacement(details), ...botIdentity(record) } : details];
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
      if (!record) { record = { subject, botId, organizer: { kind: 'person' }, lifetime: 'standing', createdAt: now, updatedAt: now }; bots.push(record); mine.set(botId, record); }
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
  for (const record of mine.values()) if (record.lifetime === 'standing' && !shown.has(record.botId) && record.retiredAt === undefined) record.retiredAt = now;
}

/** Stored bot details with each picture read in the current form; stored rows may hold shapes an older build wrote. Anything that is not bots is returned as it is. */
export function readStoredBots(bots: unknown): unknown {
  const members = (bots as { members?: unknown } | null)?.members;
  if (!members || typeof members !== 'object' || Array.isArray(members)) return bots;
  return { ...(bots as object), members: Object.fromEntries(Object.entries(members).map(([viewId, details]) => {
    if (!details || typeof details !== 'object' || !('picture' in details)) return [viewId, details];
    const { picture, ...rest } = details as { picture: unknown };
    const read = readBotPicture(picture);
    return [viewId, read ? { ...rest, picture: read } : rest];
  })) };
}
const bound = (row: SavedWorkspaceWindow) => row.window && row.bots ? groupBotViews({ window: row.window, bots: row.bots }).map(view => view.id) : [];
/** Whether some live row holds a bot view without a record. */
export function needsBotMigration(rows: readonly SavedWorkspaceWindow[]): boolean {
  return rows.some(row => !row.deleted && bound(row).some(viewId => !row.bots!.members[viewId]?.botId));
}
/** Gives every bot view of every account a record, with `migrationBotId` for those without one. Pictures are read in the current form first. */
export function migrateBots(rows: SavedWorkspaceWindow[], bots: SavedBot[], now: number): void {
  for (const row of rows) if (!row.deleted && row.bots) row.bots = readStoredBots(row.bots) as typeof row.bots;
  for (const subject of new Set(rows.map(row => row.subject))) {
    const before = new Map<string, string>();
    for (const row of rows) if (row.subject === subject && !row.deleted) for (const viewId of bound(row)) before.set(key(row.id, viewId), migrationBotId(subject, row.id, viewId));
    reconcileBots(subject, rows, bots, new Set(rows.filter(row => row.subject === subject).map(row => row.id)), before, now);
  }
}
