/**
 * Every bot's own calls (bots design 2, 3, 5.1), made as its main session. A standing bot is a bot of the Window groups; a temporary
 * bot is a task, seen as a bot: its name is the task's title, its mission the brief, its organizer the task's owner, its session the
 * worker. A message goes where its sender and receiver say: a temporary bot's to its organizer is a report, a question or progress;
 * an organizer's to its temporary bot, and any other bot's, is input to that task; anything to a standing bot goes to its inbox.
 */
import { createHash } from 'node:crypto';
import { nativeSessionRefKey, taskView, type TeamHostCall, type TaskView } from '@orchardworks/agent-remote-protocol';
import { accountDirectory, callerAssistant, type Assistant, type AssistantBrokerPorts, type AssistantMessages, type AssistantPorts } from './assistants.js';
import { ownerTasks, type TaskGroups } from './tasks.js';
import type { SavedTeam } from './team-delivery.js';

type Call<A extends TeamHostCall['action']> = Extract<TeamHostCall, { action: A }>;
type Owner = { providerId: string; nativeSessionId: string };
/** A bot as the calls see it. A temporary bot carries its task. */
export type Bot = { key: string; name: string; standing?: Assistant; task?: SavedTeam };
export interface BotListing { id: string; name: string; label?: string; mission?: string; kind: 'standing' | 'temporary'; organizer?: 'you'; status?: TaskView['state'] }

const fail = (message: string): never => { throw new Error(message); };
const fold = (text: string) => text.trim().toLocaleLowerCase('en');
const running = (team: SavedTeam) => team.status === 'active' && (team.task?.state === 'working' || team.task?.state === 'needs_input');
/** A temporary bot's id, derived from its task. */
export const temporaryBotId = (teamId: string) => 'b_' + createHash('sha256').update(JSON.stringify(['temporary', teamId])).digest('hex').slice(0, 32);
const NOT_FOUND = 'No bot of this account answers to that name. List them with list_bots.';

export class BotCalls {
  constructor(private readonly broker: AssistantBrokerPorts, private readonly ports: AssistantPorts, private readonly tasks: TaskGroups, private readonly messages: AssistantMessages) {}
  private key(hostId: string, providerId: string, nativeSessionId: string): string | undefined {
    try { return nativeSessionRefKey(this.broker.ports.resolveSession(hostId, providerId, nativeSessionId)); } catch { return undefined; }
  }
  private temporary(team: SavedTeam): Bot { return { key: temporaryBotId(team.id), name: team.task!.title, task: team }; }
  /** The calling bot: a standing bot whose view shows this session, or a temporary bot whose worker it is. */
  private caller(hostId: string, owner: Owner): Bot {
    if (!this.ports.capable(hostId)) fail('Update the Controller to use bots.');
    const own = this.key(hostId, owner.providerId, owner.nativeSessionId);
    const worker = own ? this.broker.ports.read().find(team => team.task && team.members[0]!.hostId === hostId && team.members[0]!.nativeSessionId
      && this.key(hostId, team.members[0]!.providerId, team.members[0]!.nativeSessionId) === own) : undefined;
    if (worker) return this.temporary(worker);
    const standing = callerAssistant(this.broker.ports.resolveSession, hostId, owner, accountDirectory(this.ports.groups()));
    return { key: standing.key, name: standing.name, standing };
  }
  /** The temporary bot's organizer, if the bot is one: its task's owner session, as a standing or a temporary bot. */
  private organizerOf(bot: Bot): Bot | undefined {
    if (!bot.task) return undefined;
    const seat = bot.task.members[1]!, key = this.key(seat.hostId, seat.providerId, seat.nativeSessionId!);
    const directory = accountDirectory(this.ports.groups());
    const standing = directory.find(item => this.key(item.hostId, item.providerId, item.nativeSessionId) === key);
    if (standing) return { key: standing.key, name: standing.name, standing };
    const parent = this.broker.ports.read().find(team => team.task && this.key(team.members[0]!.hostId, team.members[0]!.providerId, team.members[0]!.nativeSessionId!) === key);
    return parent ? this.temporary(parent) : undefined;
  }
  /** The temporary bots a bot organizes: the tasks its session owns. */
  private organized(hostId: string, owner: Owner): SavedTeam[] { return ownerTasks(this.broker.ports.read(), this.broker.ports.resolveSession, hostId, owner); }
  /** The bot a name or id means, among the standing bots and the temporary bots still at work. */
  private named(name: string, caller: Bot): Bot {
    const standing = accountDirectory(this.ports.groups()).filter(item => item.key.startsWith('b_')).map((item): Bot => ({ key: item.key, name: item.name, standing: item }));
    const temporary = this.broker.ports.read().filter(team => team.task && running(team)).map(team => this.temporary(team));
    const matches = [...standing, ...temporary].filter(bot => bot.key !== caller.key && (bot.key === name || fold(bot.name) === fold(name)));
    return matches.length === 1 ? matches[0]! : fail(NOT_FOUND);
  }

  async create(hostId: string, call: Call<'create_bot'>) {
    this.caller(hostId, call.owner);
    if (call.lifetime === 'standing') fail('Standing bots are created by the person for now; start a temporary bot for this work.');
    const brief = call.message ? `${call.mission}\n\n${call.message}` : call.mission;
    const created = await this.tasks.create(hostId, { action: 'create_task', owner: call.owner, operationId: call.operationId, title: call.name, brief,
      ...(call.workspace ? { workspace: call.workspace } : {}), ...(call.commit ? { commit: call.commit } : {}), ...(call.provider ? { provider: call.provider } : {}), ...(call.model ? { model: call.model } : {}) });
    return { botId: temporaryBotId(created.taskId), status: created.state, message: created.message.replace(/^Task \S+/, `Bot "${call.name}"`) };
  }
  async message(hostId: string, call: Call<'bot_message'>) {
    const from = this.caller(hostId, call.owner), organizer = this.organizerOf(from);
    const to = fold(call.to) === 'organizer' && organizer ? organizer : this.named(call.to, from);
    // A temporary bot to its organizer: its report, its question or its progress.
    if (from.task && organizer && to.key === organizer.key) {
      const memberId = from.task.members[0]!.id;
      if (call.status === 'done' || call.status === 'failed') return this.tasks.report(hostId, { action: 'report_task', teamId: from.task.id, memberId, status: call.status, summary: call.text });
      if (call.status === 'needs_input') return this.tasks.ask(hostId, { action: 'ask_owner', teamId: from.task.id, memberId, question: call.text });
      return this.tasks.progress(hostId, { teamId: from.task.id, memberId, operationId: call.operationId, text: call.text });
    }
    if (to.task) {
      const mine = this.organized(hostId, call.owner).some(team => team.id === to.task!.id);
      return mine ? this.tasks.message(hostId, { action: 'message_task', owner: call.owner, taskId: to.task.id, operationId: call.operationId, text: call.text })
        : this.tasks.input(to.task.id, from.name, { operationId: call.operationId, text: call.text });
    }
    return this.messages.deliver(from.standing ?? { key: from.key, name: from.name }, to.standing!, { operationId: call.operationId, text: call.text, ...(call.replyTo ? { replyTo: call.replyTo } : {}) });
  }
  list(hostId: string, call: Call<'list_bots'>): { bots: BotListing[] } {
    const self = this.caller(hostId, call.owner), organizer = this.organizerOf(self);
    const standing = accountDirectory(this.ports.groups()).filter(item => item.key.startsWith('b_') && item.key !== self.key && !item.hidden)
      .map((item): BotListing => ({ id: item.key, name: item.name, kind: 'standing', ...(item.label ? { label: item.label } : {}), ...(item.mission ? { mission: item.mission } : {}) }));
    const mine = this.organized(hostId, call.owner).map((team): BotListing => ({ id: temporaryBotId(team.id), name: team.task!.title, kind: 'temporary', organizer: 'you', status: taskView(team).state, mission: team.task!.brief }));
    const above = organizer?.task ? [{ id: organizer.key, name: organizer.name, kind: 'temporary' as const, mission: organizer.task.task!.brief }] : [];
    return { bots: [...above, ...mine, ...standing] };
  }
  /** The organizer's hold on one of its temporary bots: stop its work, retire it, or read where its session is. */
  async organize(hostId: string, call: Call<'stop_bot' | 'retire_bot' | 'bot_session'>) {
    this.caller(hostId, call.owner);
    const team = this.organized(hostId, call.owner).find(item => temporaryBotId(item.id) === call.bot || fold(item.task!.title) === fold(call.bot))
      ?? fail('You do not organize a bot by that name; list them with list_bots.');
    if (call.action === 'bot_session') {
      const worker = team.members[0]!;
      if (!worker.nativeSessionId || worker.hostId !== hostId) fail('That bot runs on another computer; ask it with message instead.');
      return { providerId: worker.providerId, nativeSessionId: worker.nativeSessionId };
    }
    if (!running(team)) return { botId: temporaryBotId(team.id), status: team.task!.state };
    const done = await this.tasks.finish(hostId, call.action === 'stop_bot' ? { action: 'cancel_task', owner: call.owner, taskId: team.id }
      : { action: 'mark_task_done', owner: call.owner, taskId: team.id, summary: 'Retired by its organizer.' });
    return { botId: temporaryBotId(team.id), status: done.state };
  }
}
