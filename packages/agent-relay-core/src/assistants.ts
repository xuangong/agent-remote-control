/**
 * Assistants on the Team path: the account's bots as the Window groups hold them (their key, name and main session), and the
 * messages one assistant's main session sends another. A message travels on a link: a Team of the two main sessions, bound where
 * they are, whose deliveries wait for the receiver to be idle like task updates and arrive framed as [Message from …].
 */
import { createHash, randomUUID } from 'node:crypto';
import { accountAssistants, assistantMessageText, assistantNamesIn, ASSISTANT_MESSAGE_HOP_LIMIT, botViews, nativeSessionRefKey, viewAssistantKey,
  type Team, type TeamHostCall, type TeamMember, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { ACCOUNT_TEAM_LIMIT, assertTeamQueueCapacity, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import type { TeamBrokerPorts } from './teams.js';
import { pruneTasks } from './tasks.js';

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
}
type ListCall = Extract<TeamHostCall, { action: 'list_assistants' }>;
type MessageCall = Extract<TeamHostCall, { action: 'message_assistant' }>;
export interface Assistant { key: string; name: string; label?: string; hidden: boolean; hostId: string; providerId: string; nativeSessionId: string }

const RECENT_KEEP = 64;
/** One answer for an assistant that does not exist and one this caller may not reach, so the roster cannot be probed. */
const NOT_FOUND = 'No assistant of this account answers to that name. List them with list_assistants.';
const fail = (message: string): never => { throw new Error(message); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fold = (text: string) => text.trim().toLocaleLowerCase('en');

/** The account's assistants: every bot view, named by the account's naming rule, with the session it shows now. */
export function accountDirectory(groups: readonly WindowGroup[]): Assistant[] {
  const names = assistantNamesIn(accountAssistants(groups), 'en');
  return groups.flatMap(group => botViews(group).map(view => {
    const key = viewAssistantKey(group.window.id, view.id), details = group.bots?.members[view.id];
    return { key, name: names.get(key) ?? view.binding.title, ...(details?.label ? { label: details.label } : {}), hidden: details?.hidden === true,
      hostId: view.binding.hostId, providerId: view.binding.providerId, nativeSessionId: view.binding.nativeSessionId };
  }));
}

/** The calling session's own assistant: the bot whose view shows that session, or the session that holds its role now. */
export function callerAssistant(resolve: TeamBrokerPorts['resolveSession'], hostId: string, owner: { providerId: string; nativeSessionId: string }, directory: readonly Assistant[]): Assistant {
  const key = (host: string, providerId: string, nativeSessionId: string) => { try { return nativeSessionRefKey(resolve(host, providerId, nativeSessionId)); } catch { return undefined; } };
  const own = key(hostId, owner.providerId, owner.nativeSessionId);
  return (own ? directory.find(item => item.hostId === hostId && key(item.hostId, item.providerId, item.nativeSessionId) === own) : undefined)
    ?? fail('Only an assistant\'s main session does this.');
}
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
  constructor(private readonly broker: AssistantBrokerPorts, private readonly ports: AssistantPorts) {}
  capable(hostId: string): boolean { return this.ports.capable(hostId); }
  private caller(hostId: string, owner: ListCall['owner'], directory: readonly Assistant[]): Assistant {
    return callerAssistant(this.broker.ports.resolveSession, hostId, owner, directory);
  }
  list(hostId: string, call: ListCall): { assistants: Array<{ id: string; name: string; label?: string }> } {
    if (!this.ports.capable(hostId)) fail('Update the Controller to message assistants.');
    const directory = accountDirectory(this.ports.groups()), self = this.caller(hostId, call.owner, directory);
    return { assistants: directory.filter(item => item.key !== self.key && !item.hidden).map(item => ({ id: item.key, name: item.name, ...(item.label ? { label: item.label } : {}) })) };
  }
  async message(hostId: string, call: MessageCall): Promise<{ messageId: string; outcome: 'delivered' | 'held' }> {
    if (!this.ports.capable(hostId)) fail('Update the Controller to message assistants.');
    const directory = accountDirectory(this.ports.groups()), from = this.caller(hostId, call.owner, directory);
    const to = namedAssistant(directory, call.to, from);
    const sent = await this.broker.change(teams => {
      const now = this.broker.ports.now();
      let team = teams.find(item => item.link?.assistants.includes(from.key) && item.link.assistants.includes(to.key));
      if (!team) {
        pruneTasks(teams, 1);
        if (plain(teams).length >= ACCOUNT_TEAM_LIMIT) fail('Team capacity reached.');
        const seat = (item: Assistant) => assistantSeat(item, now);
        team = { id: randomUUID(), operationId: digest(['link', [from.key, to.key].sort()]), revision: 1, title: `${from.name} and ${to.name}`, status: 'active',
          source: { hostId: from.hostId, providerId: from.providerId, nativeSessionId: from.nativeSessionId, title: from.name },
          members: [seat(from), seat(to)], messages: [], link: { assistants: [from.key, to.key], recent: [] }, createdAt: now, updatedAt: now };
        teams.push(team);
      }
      const link = team.link!, index = link.assistants.indexOf(from.key), sender = team.members[index]!, receiver = team.members[1 - index]!;
      const existing = link.recent.find(item => item.operationId === call.operationId && item.from === sender.id);
      if (existing) return { teamId: team.id, messageId: existing.id, receiver: receiver.id, sender: sender.id };
      let hop = 1;
      if (call.replyTo) {
        const parent = link.recent.find(item => item.id === call.replyTo && item.from === receiver.id) ?? fail('reply_to must name a message this assistant received from them.');
        hop = parent.hop + 1;
        if (hop > ASSISTANT_MESSAGE_HOP_LIMIT) fail(`This exchange reached ${ASSISTANT_MESSAGE_HOP_LIMIT} messages. Stop here and tell the person what was said.`);
      }
      const messageId = `m${digest([team.id, sender.id, call.operationId]).slice(0, 12)}`;
      const message = { id: digest(['assistant-message', team.id, messageId]), from: sender.id, to: receiver.id, status: 'queued' as const, createdAt: now,
        text: assistantMessageText({ messageId, from: from.name, ...(call.replyTo ? { replyTo: call.replyTo } : {}), body: call.text }) };
      assertTeamQueueCapacity(team, message);
      team.messages.push(message);
      link.recent.push({ id: messageId, from: sender.id, hop, operationId: call.operationId });
      if (link.recent.length > RECENT_KEEP) link.recent.splice(0, link.recent.length - RECENT_KEEP);
      team.revision++; team.updatedAt = now;
      return { teamId: team.id, messageId, receiver: receiver.id, sender: sender.id };
    });
    // Binding a main session where it is never creates anything, so a Host that was offline is asked again with the next message.
    let receiver: TeamMember | undefined;
    for (const memberId of [sent.sender, sent.receiver]) {
      const team = await this.broker.provision(sent.teamId, memberId).catch(() => undefined);
      if (memberId === sent.receiver) receiver = team?.members.find(item => item.id === memberId);
    }
    return { messageId: sent.messageId, outcome: receiver?.creation === 'ready' ? 'delivered' : 'held' };
  }
}
