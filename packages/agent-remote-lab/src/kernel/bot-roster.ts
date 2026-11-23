import { botViews, hasBotAppearance, windowSessionIdentity, type WindowBotDetails, type WindowGroup, type WindowSessionBinding, type WindowView } from '@orchardworks/agent-remote-protocol';
import { assistantStatus, translator, type AssistantStatus, type Translate } from '@orchardworks/agent-client';
import type { SessionActivityStatus } from './session-activity-status.js';
import { sessionKey, type SessionEntry } from './session-tree.js';
import { accountNames, type AccountNames } from './assistant-names.js';
import { rankBetween } from './ranks.js';

/** A bot's position, shown as a tag beside its name like a job title, in the reader's words; ordinary bots have none. */
export type BotRole = string;
/** An Ask: the only secondary level, listed under the bot it belongs to. */
export interface BotAsk { viewId: string; title: string }
/** A native session, wherever it runs. */
export interface BotSessionRef { hostId: string; providerId: string; nativeSessionId: string }
export interface BotRow {
  groupId: string; viewId: string; binding: WindowSessionBinding;
  /** The name the assistant is called by: its stored name or its generated one, never its session's title. */
  name: string;
  /** The session that drives the bot now: after a handoff, its successor; otherwise the view's own session. */
  session: BotSessionRef;
  details: WindowBotDetails; role?: BotRole; asks: BotAsk[];
  /** The session's activity, and what the assistant is doing in one sentence (needs you, working, Host offline, resting…). */
  activity: SessionActivityStatus; assistant: AssistantStatus;
  /** The bot's latest reply, as its Host reported it, and whether the owner has not seen it yet. */
  reply?: { replyAt: number; preview: string }; unread?: true;
  /** What the owner typed for the bot and has not sent, on any device. */
  draft?: string;
  /** Messages to the bot wait in the outbox for its Host. */
  waiting?: true;
  /** Only in the directory: the bot is hidden in Bot mode (itself, or its whole group), so Chats does not list it. */
  hiddenInChats?: true;
  /** Muted, itself or with its group: no reminders, and a quiet unread dot. */
  muted?: true;
  /** The name of the bot that created this one and organizes it (bots design 10). */
  organizer?: string;
}
/** `hidden` lists the views of this group's bots hidden in Bot mode, which the group can show again. */
export interface BotSection { groupId: string; title: string; rows: BotRow[]; hidden: string[]; unread?: true; /** Only in the directory: the group is hidden in Bot mode. */ hiddenInChats?: true }
export interface BotRosterModel { sections: BotSection[]; other: SessionEntry[] }
export interface BotRosterOptions {
  status(session: BotSessionRef): SessionActivityStatus;
  /** The session that drives a bot now; by default the view's own binding. */
  current?(groupId: string, viewId: string, binding: WindowSessionBinding): BotSessionRef;
  /** The bot's sessions before its handoffs, when known, most recent first: its conversation continues into them. */
  earlier?(groupId: string, viewId: string, binding: WindowSessionBinding): BotSessionRef[];
  /** A session's latest reply, when known. */
  reply?(session: BotSessionRef): { replyAt: number; preview: string } | undefined;
  /** Whether a reply a session produced at replyAt is one the owner has not seen. */
  unread?(session: BotSessionRef, replyAt: number): boolean;
  /** A session's unsent draft, shared across devices. */
  draft?(session: BotSessionRef): string | undefined;
  /** Whether messages to a session wait in the outbox for its Host. */
  waiting?(session: BotSessionRef): boolean;
  /** Whether a Host is online and its name, as far as this page knows. */
  host?(hostId: string): { online: boolean; name?: string } | undefined;
  /** The words of the reader's locale for the assistants' sentences; English by default. */
  t?: Translate;
  /** The names the account's assistants are called by; by default those of `groups`. */
  names?: AccountNames;
  /** The assistant directory: every group and every bot, the hidden ones marked rather than left out. */
  everyone?: boolean;
}
/** A rank after every group's, so a new group is listed last. */
export function appendedRank(groups: readonly WindowGroup[]): string {
  const last = groups.flatMap(group => group.bots ? [group.bots.rank] : []).sort().at(-1);
  return !last ? 'm' : rankBetween(last, undefined) ?? last;
}
/** Native directory timestamps are metadata, never activity evidence. */
export type DatedSessionEntry = SessionEntry & { updatedAt?: string };
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function sortDirectorySessions(entries: readonly DatedSessionEntry[]): DatedSessionEntry[] {
  const unique = new Map<string, DatedSessionEntry>();
  for (const entry of entries) if (!unique.has(sessionKey(entry))) unique.set(sessionKey(entry), entry);
  const descending = (a?: string, b?: string) => a === b ? 0 : !a ? 1 : !b ? -1 : lexical(b, a);
  return [...unique.values()].sort((a, b) => descending(a.updatedAt, b.updatedAt) || descending(a.createdAt, b.createdAt) || lexical(sessionKey(a), sessionKey(b)));
}

/** The role a bot's view carries: from its feature (Team, Support, TPM) or, for a Side, from being attached to its source. */
export function botRole(view: WindowView, t: Translate = translator('en')): BotRole | undefined {
  if (view.feature?.kind === 'tpm') return t('navigation.roleTpm');
  if (view.feature?.kind === 'team') {
    const role = view.feature.metadata?.role;
    if (role === 'leader') return t('navigation.roleTeamLeader');
    if (role === 'member') return t('navigation.roleTeamMember');
  }
  if (view.placement === 'attached') return t('navigation.roleSide');
}


/**
 * Bot mode's roster: every group that is not hidden in Bot mode and has a bot or was made in Bot mode, in catalog order, each
 * session once, bots ordered by pin, rank and place, Asks under their bot. Sessions in no group are Other sessions.
 */
export function projectBotRoster(groups: readonly WindowGroup[], directory: readonly SessionEntry[], options: BotRosterOptions): BotRosterModel {
  const names = options.names ?? accountNames(groups, options.t);
  const everyone = options.everyone === true;
  const shownGroups = everyone ? groups : groups.filter(hasBotAppearance);
  // Each bot's name by its record's id, so a bot's row names the bot that organizes it.
  const byBotId = new Map(groups.flatMap(group => Object.entries(group.bots?.members ?? {}).flatMap(([viewId, item]) => item.botId ? [[item.botId, names.view(group.window.id, viewId)] as const] : [])));
  const candidatesOf = new Map(shownGroups.map(group => {
    const members = group.bots?.members ?? {};
    const candidates = botViews(group).map((view, order) => ({ view, order, details: members[view.id] ?? {} })).filter(item => everyone || !item.details.hidden);
    candidates.sort((a, b) => Number(!!b.details.pinned) - Number(!!a.details.pinned)
      || (a.details.rank && b.details.rank ? lexical(a.details.rank, b.details.rank) : a.details.rank ? -1 : b.details.rank ? 1 : 0) || a.order - b.order);
    return [group, candidates] as const;
  }));
  // A session shows once: a group with bot details (where the Relay keeps it unique) claims it before a group formed from
  // sessions, and otherwise the first group in catalog order does.
  const owner = new Map<string, string>();
  for (const group of [...shownGroups.filter(group => group.bots), ...shownGroups.filter(group => !group.bots)]) {
    for (const { view } of candidatesOf.get(group)!) {
      const identity = windowSessionIdentity(view.binding);
      if (!owner.has(identity)) owner.set(identity, JSON.stringify([group.window.id, view.id]));
    }
  }
  // Groups keep catalog (creation) order, as Windows do: giving a bot a label or hiding one never moves its group.
  const sections = shownGroups.flatMap((group): BotSection[] => {
    const members = group.bots?.members ?? {};
    const visible = candidatesOf.get(group)!.filter(({ view }) => owner.get(windowSessionIdentity(view.binding)) === JSON.stringify([group.window.id, view.id]));
    // A group formed from sessions appears once it has a bot; a group made in Bot mode (it carries details) appears while still empty.
    if (!visible.length && !group.bots) return [];
    const asks = group.window.views.filter(view => view.feature?.kind === 'ask' && view.closeWith);
    const sessions = visible.map(({ view }) => options.current?.(group.window.id, view.id, view.binding)
      ?? { hostId: view.binding.hostId, providerId: view.binding.providerId, nativeSessionId: view.binding.nativeSessionId });
    const activities = sessions.map(session => options.status(session));
    const rows = visible.map(({ view, details }, index): BotRow => {
      // The conversation is the chain of the bot's sessions: its latest reply may still be in the session before a handoff.
      const session = sessions[index]!, own = { hostId: view.binding.hostId, providerId: view.binding.providerId, nativeSessionId: view.binding.nativeSessionId };
      const chain = [...new Map([session, own, ...options.earlier?.(group.window.id, view.id, view.binding) ?? []].map(item => [sessionKey(item), item])).values()];
      const candidates = chain.flatMap(owner => {
        const reply = options.reply?.(owner); return reply ? [{ owner, reply }] : [];
      }).sort((a, b) => b.reply.replyAt - a.reply.replyAt);
      const latest = candidates[0], reply = latest?.reply, draft = options.draft?.(session), waiting = options.waiting?.(session) ?? false;
      const host = options.host?.(session.hostId), activity = activities[index]!;
      const assistant = assistantStatus({ activity, ...(host ? { host } : {}), asleep: !!details.asleep, waitingToSend: waiting, ...(reply ? { replyPreview: reply.preview } : {}) }, options.t);
      return { groupId: group.window.id, viewId: view.id, binding: view.binding, name: names.view(group.window.id, view.id), session, details, activity, assistant,
        ...(botRole(view, options.t) ? { role: botRole(view, options.t)! } : {}),
        asks: asks.filter(ask => ask.closeWith === view.id).map(ask => ({ viewId: ask.id, title: ask.binding?.title ?? 'Ask' })),
        ...(reply ? { reply } : {}), ...(latest && options.unread?.(latest.owner, latest.reply.replyAt) ? { unread: true as const } : {}),
        ...(draft?.trim() ? { draft } : {}), ...(waiting ? { waiting: true as const } : {}), ...(details.muted || group.bots?.muted ? { muted: true as const } : {}),
        ...(everyone && (details.hidden || !hasBotAppearance(group)) ? { hiddenInChats: true as const } : {}),
        ...(details.organizer && byBotId.has(details.organizer) ? { organizer: byBotId.get(details.organizer)! } : {}) };
    });
    const hidden = botViews(group).filter(view => members[view.id]?.hidden).map(view => view.id);
    return [{ groupId: group.window.id, title: group.window.title, rows, hidden,
      ...(rows.some(row => row.unread) ? { unread: true as const } : {}), ...(everyone && !hasBotAppearance(group) ? { hiddenInChats: true as const } : {}) }];
  });
  const grouped = new Set(groups.flatMap(group => group.window.views.flatMap(view => view.binding ? [sessionKey(view.binding)] : [])));
  return { sections, other: sortDirectorySessions(directory.filter(entry => !grouped.has(sessionKey(entry)))) };
}
