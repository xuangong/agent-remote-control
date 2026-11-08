import { groupBotViews, type WindowBotDetails, type WindowGroup, type WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import { windowActivity, type SessionActivityStatus } from './session-activity-status.js';
import { sessionKey, type SessionEntry } from './session-tree.js';

export interface BotRow {
  groupId: string; viewId: string; binding: WindowSessionBinding;
  details: WindowBotDetails; status?: 'Needs you' | 'Working' | 'Failed';
}
export interface BotSection { groupId: string; title: string; rows: BotRow[]; status?: BotRow['status'] }
export interface BotRosterModel { sections: BotSection[]; other: SessionEntry[] }
/** Native directory timestamps are metadata, never activity evidence. */
export type DatedSessionEntry = SessionEntry & { updatedAt?: string };
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function botActivityLabel(value: SessionActivityStatus | undefined): BotRow['status'] {
  if (value === 'waiting' || value === 'starting') return 'Needs you';
  if (value === 'running') return 'Working';
  if (value === 'failed') return 'Failed';
}
export function sortDirectorySessions(entries: readonly DatedSessionEntry[]): DatedSessionEntry[] {
  const unique = new Map<string, DatedSessionEntry>();
  for (const entry of entries) if (!unique.has(sessionKey(entry))) unique.set(sessionKey(entry), entry);
  const descending = (a?: string, b?: string) => a === b ? 0 : !a ? 1 : !b ? -1 : lexical(b, a);
  return [...unique.values()].sort((a, b) => descending(a.updatedAt, b.updatedAt) || descending(a.createdAt, b.createdAt) || lexical(sessionKey(a), sessionKey(b)));
}
export function projectBotRoster(groups: readonly WindowGroup[], directory: readonly SessionEntry[], status: (binding: WindowSessionBinding) => SessionActivityStatus): BotRosterModel {
  const sections = groups.filter(group => group.bots).slice().sort((a, b) => lexical(a.bots!.rank, b.bots!.rank) || lexical(a.window.id, b.window.id)).map(group => {
    const visible = groupBotViews(group).map((view, order) => ({ view, order, details: group.bots!.members[view.id] ?? {} })).filter(item => !item.details.hidden);
    visible.sort((a, b) => Number(!!b.details.pinned) - Number(!!a.details.pinned)
      || (a.details.rank && b.details.rank ? lexical(a.details.rank, b.details.rank) : a.details.rank ? -1 : b.details.rank ? 1 : 0) || a.order - b.order);
    const activities = visible.map(({ view }) => status(view.binding));
    const rows = visible.map(({ view, details }, index): BotRow => ({ groupId: group.window.id, viewId: view.id, binding: view.binding, details, status: botActivityLabel(activities[index]) }));
    return { groupId: group.window.id, title: group.window.title, rows, status: botActivityLabel(windowActivity(activities)) };
  });
  const grouped = new Set(groups.flatMap(group => group.window.views.flatMap(view => view.binding ? [sessionKey(view.binding)] : [])));
  return { sections, other: sortDirectorySessions(directory.filter(entry => !grouped.has(sessionKey(entry)))) };
}
