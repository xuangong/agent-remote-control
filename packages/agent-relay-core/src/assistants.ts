/**
 * Assistants on the Team path: the account's bots as the Window groups hold them (their key, name and main session), and the
 * messages one assistant's main session sends another. A message travels on a link: a Team of the two main sessions, bound where
 * they are, whose deliveries wait for the receiver to be idle like task updates and arrive framed as [Message from …].
 */
import { createHash, randomUUID } from 'node:crypto';
import { accountAssistants, assistantMessageText, assistantNamesIn, botViews, personWroteText, type BotFact, type BotMessageResult, nativeSessionRefKey, viewAssistantKey,
  type Team, type TeamHostCall, type TeamMember, type WindowBotDetails, type WindowGroup, type WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import { ACCOUNT_TEAM_LIMIT, assertTeamQueueCapacity, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import type { TeamBrokerPorts } from './teams.js';
import type { BotInboxes } from './inboxes.js';
import { pushBackTimers } from './bot-work.js';

/** What the Team broker lends assistant messages. */
export interface AssistantBrokerPorts {
  ports: TeamBrokerPorts;
  change<T>(update: (teams: SavedTeam[]) => T): Promise<T>;
  provision(teamId: string, memberId: string): Promise<Team>;
}
export interface AssistantPorts {
  /** The account's Window groups, where its bots are. */
  groups(): readonly WindowGroup[];
  /** The Host runs links; others never see them. */
  capable(hostId: string): boolean;
  /** Places a bot another bot created in a group of the account. */
  placeBot?(groupId: string, view: { id: string; binding: WindowSessionBinding }, details: WindowBotDetails): Promise<void>;
  /** Records a standing bot's own lasting change to its mission. */
  setMission?(groupId: string, viewId: string, mission: string): Promise<void>;
  /** Records a standing bot's memory as it stands now (its own sessions and the person write it). */
  setMemory?(groupId: string, viewId: string, memory: BotFact[]): Promise<void>;
  /** Moves a standing bot to another chief: a bot's id, or null for the person. */
  setChief?(botId: string, chief: string | null): Promise<void>;
}
type ListCall = Extract<TeamHostCall, { action: 'list_assistants' }>;
type MessageCall = Extract<TeamHostCall, { action: 'message_assistant' }>;
export interface Assistant { key: string; groupId: string; viewId: string; name: string; label?: string; mission?: string; memory?: BotFact[]; chief?: string; hidden: boolean; hostId: string; providerId: string; nativeSessionId: string }

const RECENT_KEEP = 64;
/** One answer for an assistant that does not exist and one this caller may not reach, so the roster cannot be probed. */
const NOT_FOUND = 'No assistant of this account answers to that name. List them with list_assistants.';
const fail = (message: string): never => { throw new Error(message); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fold = (text: string) => text.trim().toLocaleLowerCase('en');

/**
 * The account's assistants: every bot view, named by the account's naming rule, with the session it shows now. One in coordinator
 * mode whose provider cannot take the task tools works as a plain one.
 */
/** The account's assistants: every bot view, named by the account's naming rule, with the session it shows now. */
export function accountDirectory(groups: readonly WindowGroup[]): Assistant[] {
  const names = assistantNamesIn(accountAssistants(groups), 'en');
  return groups.flatMap(group => botViews(group).map(view => {
    // The id is the bot's record, which a move between groups keeps; names follow the account's naming rule, keyed by place.
    const viewKey = viewAssistantKey(group.window.id, view.id), details = group.bots?.members[view.id];
    const key = details?.botId ?? viewKey;
    return { key, groupId: group.window.id, viewId: view.id, name: names.get(viewKey) ?? view.binding.title, ...(details?.label ? { label: details.label } : {}), ...(details?.mission ? { mission: details.mission } : {}), ...(details?.memory?.length ? { memory: details.memory } : {}), ...(details?.chief ? { chief: details.chief } : {}), hidden: details?.hidden === true,
      hostId: view.binding.hostId, providerId: view.binding.providerId, nativeSessionId: view.binding.nativeSessionId };
  }));
}

/** The calling session's own assistant: the bot whose view shows that session, or the session that holds its role now. */
export function callerAssistant(resolve: TeamBrokerPorts['resolveSession'], hostId: string, owner: { providerId: string; nativeSessionId: string }, directory: readonly Assistant[]): Assistant {
  const key = (host: string, providerId: string, nativeSessionId: string) => { try { return nativeSessionRefKey(resolve(host, providerId, nativeSessionId)); } catch { return undefined; } };
  const own = key(hostId, owner.providerId, owner.nativeSessionId);
  return (own ? sessionAssistant(directory.filter(item => item.hostId === hostId && key(item.hostId, item.providerId, item.nativeSessionId) === own)) : undefined)
    ?? fail('Only an assistant\'s main session does this.');
}
/** A session a plain window shows beside the group that makes it a bot speaks as the bot, never as the plain window. */
export const sessionAssistant = (shown: readonly Assistant[]): Assistant | undefined => shown.find(item => item.key.startsWith('b_')) ?? shown[0];
/** The assistant a name or id means, other than the caller; one answer for unknown and unreachable. */
export function namedAssistant(directory: readonly Assistant[], name: string, caller: Assistant): Assistant {
  const named = directory.filter(item => item.key === name || fold(item.name) === fold(name));
  return named.length === 1 && named[0]!.key !== caller.key ? named[0]! : fail(NOT_FOUND);
}
/** An assistant's main session as a seat bound where it is. */
export function assistantSeat(item: Assistant, now: number): TeamMember {
  return { id: randomUUID(), role: 'requester', hostId: item.hostId, providerId: item.providerId, nativeSessionId: item.nativeSessionId,
    name: item.name, responsibility: 'This assistant\'s main session.', creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now };
}

export class AssistantMessages {
  constructor(private readonly broker: AssistantBrokerPorts, private readonly ports: AssistantPorts, private readonly inboxes: BotInboxes) {}
  capable(hostId: string): boolean { return this.ports.capable(hostId); }
  private caller(hostId: string, owner: ListCall['owner'], directory: readonly Assistant[]): Assistant {
    return callerAssistant(this.broker.ports.resolveSession, hostId, owner, directory);
  }
  /** Throws unless the session is the main session of a bot. */
  assertBot(hostId: string, owner: ListCall['owner']): void { this.caller(hostId, owner, accountDirectory(this.ports.groups())); }

  /** The bots whose main session is on the Host, as the directory has them. */
  hostBots(hostId: string): Assistant[] {
    if (!this.ports.capable(hostId)) return [];
    return accountDirectory(this.ports.groups()).filter(item => item.hostId === hostId && item.key.startsWith('b_'));
  }
  /** Every bot whose main session is on the Host, as the session that holds its role now, with its mission: its standing instructions. */
  bots(hostId: string): Array<{ providerId: string; nativeSessionId: string; botId: string; mission?: string; memory?: BotFact[] }> {
    return this.hostBots(hostId).flatMap(item => {
      try { const current = this.broker.ports.resolveSession(item.hostId, item.providerId, item.nativeSessionId);
        return [{ providerId: current.providerId, nativeSessionId: current.nativeSessionId, botId: item.key, ...(item.mission ? { mission: item.mission } : {}), ...(item.memory ? { memory: item.memory } : {}) }]; }
      catch { return []; }
    });
  }
  list(hostId: string, call: ListCall): { assistants: Array<{ id: string; name: string; label?: string }> } {
    if (!this.ports.capable(hostId)) fail('Update the Controller to message assistants.');
    const directory = accountDirectory(this.ports.groups()), self = this.caller(hostId, call.owner, directory);
    return { assistants: directory.filter(item => item.key !== self.key && !item.hidden).map(item => ({ id: item.key, name: item.name, ...(item.label ? { label: item.label } : {}) })) };
  }
  /** A message to another bot arrives in its inbox, framed with the sender's name, between its turns (bots design 3). */
  async message(hostId: string, call: MessageCall): Promise<BotMessageResult> {
    if (!this.ports.capable(hostId)) fail('Update the Controller to message assistants.');
    const directory = accountDirectory(this.ports.groups()), from = this.caller(hostId, call.owner, directory);
    const to = namedAssistant(directory, call.to, from);
    if (!to.key.startsWith('b_') || !from.key.startsWith('b_')) fail(NOT_FOUND);
    return this.deliver(from, to, call);
  }
  /** Queues a message from a bot (standing or temporary) in a standing bot's inbox. */
  async deliver(from: { key: string; name: string }, to: Assistant, call: { operationId: string; text: string; replyTo?: string; final?: boolean; frame?: 'person'; tag?: string; ack?: true }): Promise<BotMessageResult> {
    const sent = await this.broker.change(teams => {
      const now = this.broker.ports.now();
      const inbox = this.inboxes.prepare(teams, to, now) ?? fail('Team capacity reached.');
      const recent = inbox.inbox!.recent ??= [];
      const existing = recent.find(item => item.operationId === call.operationId && item.from === from.key);
      if (existing) return { messageId: existing.id, duplicate: true };
      let hop = 1;
      if (call.replyTo) {
        // A temporary bot has no inbox: what reached it came as input to its task, so it names no earlier message.
        const own = 'hostId' in from ? this.inboxes.current(teams, from as Assistant)?.inbox?.recent ?? [] : [];
        const parent = own.find(item => item.id === call.replyTo && item.from === to.key) ?? fail('reply_to must name a message this assistant received from them.');
        // The depth is recorded in the chain, not refused (bots design 7).
        hop = parent.hop + 1;
      }
      const seat = inbox.members[0]!, messageId = `m${digest([inbox.id, from.key, call.operationId]).slice(0, 12)}`;
      const message = { id: digest(['assistant-message', inbox.id, messageId]), from: seat.id, to: seat.id, status: 'queued' as const, createdAt: now, ...(call.ack ? { ack: call.ack } : {}),
        // The person's words to a bot are framed as what they are, from the record; any other text is a bot's message.
        text: call.frame === 'person' ? personWroteText({ bot: from.name, text: call.text }) : assistantMessageText({ messageId, from: from.name, ...(call.replyTo ? { replyTo: call.replyTo, ...(call.final ? { final: true } : {}) } : {}), ...(call.tag ? { tag: call.tag } : {}), body: call.text }) };
      assertTeamQueueCapacity(inbox, message);
      inbox.messages.push(message); pushBackTimers(inbox, now);
      recent.push({ id: messageId, from: from.key, hop, operationId: call.operationId });
      if (recent.length > RECENT_KEEP) recent.splice(0, recent.length - RECENT_KEEP);
      inbox.revision++; inbox.updatedAt = now;
      return { messageId, duplicate: false };
    });
    if (sent.duplicate) return { outcome: 'duplicate', messageId: sent.messageId };
    // Binding a main session where it is never creates anything, so a Host that was offline is asked again with the next message.
    const receiver = await this.inboxes.bind(to);
    return { messageId: sent.messageId, outcome: receiver?.creation === 'ready' ? 'delivered' : 'held' };
  }
  /** Tells a bot something the Relay wrote from the record, between its turns; `key` makes a repeated notice queue once. */
  async notice(to: Assistant, key: unknown[], text: string): Promise<void> {
    await this.broker.change(teams => {
      const now = this.broker.ports.now(), inbox = this.inboxes.prepare(teams, to, now) ?? fail('Team capacity reached.'), seat = inbox.members[0]!;
      const message = { id: digest(['notice', inbox.id, ...key]), from: seat.id, to: seat.id, status: 'queued' as const, createdAt: now, text };
      if (inbox.messages.some(item => item.id === message.id)) return;
      assertTeamQueueCapacity(inbox, message);
      inbox.messages.push(message); pushBackTimers(inbox, now);
      inbox.revision++; inbox.updatedAt = now;
    });
    await this.inboxes.bind(to);
  }

}
