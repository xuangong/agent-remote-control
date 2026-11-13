import { botViews, hasBotAppearance, windowSessionIdentity, type WindowBotDetails, type WindowGroup, type WindowSessionBinding, type WindowView } from '@orchardworks/agent-remote-protocol';
import { windowActivity, type SessionActivityStatus } from './session-activity-status.js';
import { sessionKey, type SessionEntry } from './session-tree.js';

/** A bot's position, shown as a tag beside its name like a job title; ordinary bots have none. */
export type BotRole = 'Side' | 'Team Leader' | 'Team member' | 'Support' | 'TPM';
/** An Ask: the only secondary level, listed under the bot it belongs to. */
export interface BotAsk { viewId: string; title: string }
export interface BotRow {
  groupId: string; viewId: string; binding: WindowSessionBinding;
  details: WindowBotDetails; role?: BotRole; asks: BotAsk[]; status?: 'Needs you' | 'Working' | 'Failed';
}
export interface BotSection { groupId: string; title: string; rows: BotRow[]; status?: BotRow['status'] }
export interface BotRosterModel { sections: BotSection[]; other: SessionEntry[] }
export interface BotRosterOptions {
  status(binding: WindowSessionBinding): SessionActivityStatus;
  /** Whether a Team is a Support roster (it has a call-for-support configuration); its leader then shows the Support role. */
  supportTeam?(teamId: string): boolean;
}
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

/** The role a bot's view carries: from its feature (Team, Support, TPM) or, for a Side, from being attached to its source. */
export function botRole(view: WindowView, supportTeam?: (teamId: string) => boolean): BotRole | undefined {
  if (view.feature?.kind === 'tpm') return 'TPM';
  if (view.feature?.kind === 'team') {
    const role = view.feature.metadata?.role;
    if (role === 'leader') return supportTeam?.(view.feature.id) ? 'Support' : 'Team Leader';
    if (role === 'member') return 'Team member';
  }
  if (view.placement === 'attached') return 'Side';
}

/** Groups in roster order: ranked groups by rank, then the others in catalog order, so places stay stable. */
function rosterOrder(groups: readonly WindowGroup[]): WindowGroup[] {
  const ranked = groups.filter(group => group.bots).sort((a, b) => lexical(a.bots!.rank, b.bots!.rank) || lexical(a.window.id, b.window.id));
  return [...ranked, ...groups.filter(group => !group.bots)];
}

/**
 * Bot mode's roster: every group that is not hidden in Bot mode and has a bot or was made in Bot mode, each session once (in the first group that holds it),
 * bots ordered by pin, rank and place, Asks under their bot. Sessions in no group are Other sessions.
 */
export function projectBotRoster(groups: readonly WindowGroup[], directory: readonly SessionEntry[], options: BotRosterOptions): BotRosterModel {
  const shown = new Set<string>();
  const sections = rosterOrder(groups.filter(hasBotAppearance)).flatMap((group): BotSection[] => {
    const members = group.bots?.members ?? {};
    const candidates = botViews(group).map((view, order) => ({ view, order, details: members[view.id] ?? {} }))
      .filter(item => !item.details.hidden && !shown.has(windowSessionIdentity(item.view.binding)));
    candidates.sort((a, b) => Number(!!b.details.pinned) - Number(!!a.details.pinned)
      || (a.details.rank && b.details.rank ? lexical(a.details.rank, b.details.rank) : a.details.rank ? -1 : b.details.rank ? 1 : 0) || a.order - b.order);
    const visible = candidates.filter(item => {
      const identity = windowSessionIdentity(item.view.binding);
      if (shown.has(identity)) return false;
      shown.add(identity); return true;
    });
    // A group formed from sessions appears once it has a bot; a group made in Bot mode (it carries details) appears while still empty.
    if (!visible.length && !group.bots) return [];
    const asks = group.window.views.filter(view => view.feature?.kind === 'ask' && view.closeWith);
    const activities = visible.map(({ view }) => options.status(view.binding));
    const rows = visible.map(({ view, details }, index): BotRow => ({
      groupId: group.window.id, viewId: view.id, binding: view.binding, details, status: botActivityLabel(activities[index]),
      ...(botRole(view, options.supportTeam) ? { role: botRole(view, options.supportTeam)! } : {}),
      asks: asks.filter(ask => ask.closeWith === view.id).map(ask => ({ viewId: ask.id, title: ask.binding?.title ?? 'Ask' })),
    }));
    return [{ groupId: group.window.id, title: group.window.title, rows, status: botActivityLabel(windowActivity(activities)) }];
  });
  const grouped = new Set(groups.flatMap(group => group.window.views.flatMap(view => view.binding ? [sessionKey(view.binding)] : [])));
  return { sections, other: sortDirectorySessions(directory.filter(entry => !grouped.has(sessionKey(entry)))) };
}
