/**
 * Every bot's own calls (bots design 2, 3, 5.1), made as its main session. A standing bot is a bot of the Window groups; a temporary
 * bot is a task, seen as a bot: its name is the task's title, its mission the brief, its chief the task's owner, its session the
 * worker. A message goes where its sender and receiver say: a temporary bot's to its chief is a report, a question or progress;
 * an chief's to its temporary bot, and any other bot's, is input to that task; anything to a standing bot goes to its inbox.
 */
import { createHash, randomUUID } from 'node:crypto';
import { assistantMessageText, nativeSessionRefKey, taskView, type BotMessageResult, type TeamHostCall, type TaskView, type TeamMember, type WorkItem } from '@orchardworks/agent-remote-protocol';
import { accountDirectory, callerAssistant, type Assistant, type AssistantBrokerPorts, type AssistantMessages, type AssistantPorts } from './assistants.js';
import { ownerTasks, taskAction, type TaskGroups } from './tasks.js';
import { ACCOUNT_TEAM_LIMIT, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import { pruneCoordination } from './coordination-retention.js';
import type { BotInboxes } from './inboxes.js';
import type { Rooms } from './rooms.js';
import type { BotWork } from './bot-work.js';
import { newBotId } from './bot-store.js';
import { temporaryBotId } from './chain-scope.js';
import { cutReply } from './reply-text.js';

type Call<A extends TeamHostCall['action']> = Extract<TeamHostCall, { action: A }>;
type Owner = { providerId: string; nativeSessionId: string };
/** A bot as the calls see it. A temporary bot carries its task. */
export type Bot = { key: string; name: string; standing?: Assistant; task?: SavedTeam };
export interface BotListing { id: string; name: string; label?: string; mission?: string; kind: 'standing' | 'temporary'; chief?: 'you'; status?: TaskView['state'] }

const fail = (message: string): never => { throw new Error(message); };
const fold = (text: string) => text.trim().toLocaleLowerCase('en');
const running = (team: SavedTeam) => team.status === 'active' && (team.task?.state === 'working' || team.task?.state === 'needs_input');
export { temporaryBotId };
type SendCall = Pick<Call<'bot_message'>, 'owner' | 'operationId' | 'text' | 'status' | 'replyTo' | 'patch' | 'cause'>;
const NOT_FOUND = 'No bot of this account answers to that name. List them with list_bots.';

export class BotCalls {
  constructor(private readonly broker: AssistantBrokerPorts, private readonly ports: AssistantPorts, private readonly tasks: TaskGroups, private readonly messages: AssistantMessages, private readonly inboxes: BotInboxes, private readonly rooms: Rooms, private readonly work: BotWork) {}
  private key(hostId: string, providerId: string, nativeSessionId: string): string | undefined {
    try { return nativeSessionRefKey(this.broker.ports.resolveSession(hostId, providerId, nativeSessionId)); } catch { return undefined; }
  }
  /** The calling bot's id. */
  callerKey(hostId: string, owner: Owner): string { return this.caller(hostId, owner).key; }
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
  /** The temporary bot's chief, if the bot is one: its task's owner session, as a standing or a temporary bot. */
  private chiefOf(bot: Bot): Bot | undefined {
    if (!bot.task) return undefined;
    const seat = bot.task.members[1]!, key = this.key(seat.hostId, seat.providerId, seat.nativeSessionId!);
    const directory = accountDirectory(this.ports.groups());
    const standing = directory.find(item => this.key(item.hostId, item.providerId, item.nativeSessionId) === key);
    if (standing) return { key: standing.key, name: standing.name, standing };
    const parent = this.broker.ports.read().find(team => team.task && this.key(team.members[0]!.hostId, team.members[0]!.providerId, team.members[0]!.nativeSessionId!) === key);
    // The task's owner session is the chief whether or not it is a bot of the groups now.
    return parent ? this.temporary(parent) : { key: `session:${key}`, name: seat.name };
  }
  /** A bot's temporary staff: the tasks its session owns. */
  private staff(hostId: string, owner: Owner): SavedTeam[] { return ownerTasks(this.broker.ports.read(), this.broker.ports.resolveSession, hostId, owner); }
  /** The bot a name or id means, among the standing bots and the temporary bots still at work. */
  private named(name: string, caller: Bot): Bot | 'self' | undefined {
    const standing = accountDirectory(this.ports.groups()).filter(item => item.key.startsWith('b_')).map((item): Bot => ({ key: item.key, name: item.name, standing: item }));
    const temporary = this.broker.ports.read().filter(team => team.task && running(team)).map(team => this.temporary(team));
    const matches = [...standing, ...temporary].filter(bot => bot.key === name || fold(bot.name) === fold(name));
    if (matches.length !== 1) return undefined;
    return matches[0]!.key === caller.key ? 'self' : matches[0]!;
  }

  async create(hostId: string, call: Call<'create_bot'>) {
    const self = this.caller(hostId, call.owner);
    if (call.lifetime === 'standing') return this.createStanding(hostId, self, call);
    const brief = call.message ? `${call.mission}\n\n${call.message}` : call.mission;
    const created = await this.tasks.create(hostId, { action: 'create_task', owner: call.owner, operationId: call.operationId, title: call.name, brief,
      ...(call.workspace ? { workspace: call.workspace } : {}), ...(call.commit ? { commit: call.commit } : {}), ...(call.provider ? { provider: call.provider } : {}), ...(call.model ? { model: call.model } : {}) });
    return { botId: temporaryBotId(created.taskId), status: created.state, message: created.message.replace(/^Task \S+/, `Bot "${call.name}"`) };
  }
  /**
   * A standing bot another bot creates (bots design 2.2): its inbox's seat creates its session where its chief works, with its
   * standing instructions; once ready, it is placed in its chief's group (`BotInboxes.place`). Its first message waits in its inbox.
   */
  private async createStanding(hostId: string, self: Bot, call: Call<'create_bot'>) {
    if (!self.standing) fail('A temporary bot asks its chief for a standing bot.');
    if (!this.ports.placeBot) fail('Standing bots cannot be created on this Relay.');
    const providerId = call.provider ?? call.owner.providerId;
    this.broker.ports.assertHost(hostId, providerId);
    const team = await this.broker.change(teams => {
      const existing = teams.find(item => item.operationId === call.operationId && item.inbox);
      if (existing) return existing;
      pruneCoordination(teams, 1);
      if (plain(teams).length >= ACCOUNT_TEAM_LIMIT) fail('Team capacity reached.');
      const now = this.broker.ports.now(), botId = newBotId();
      const seat: TeamMember = { id: randomUUID(), role: 'leader', hostId, providerId, name: call.name, responsibility: call.mission.slice(0, 2048), creation: 'reserved', activity: 'unknown',
        summary: '', updatedAt: now, ...(call.model ? { model: call.model } : {}) };
      const created: SavedTeam = { id: randomUUID(), operationId: call.operationId, revision: 1, title: `${call.name}'s inbox`, status: 'active',
        source: { hostId, providerId: call.owner.providerId, nativeSessionId: call.owner.nativeSessionId, title: self.name }, members: [seat], messages: [],
        inbox: { botId, pending: { name: call.name, mission: call.mission, chief: self.key, groupId: self.standing!.groupId } }, createdAt: now, updatedAt: now };
      if (call.message) {
        const messageId = `m${createHash('sha256').update(JSON.stringify([created.id, self.key, call.operationId])).digest('hex').slice(0, 12)}`;
        created.messages.push({ id: createHash('sha256').update(JSON.stringify(['first-message', created.id])).digest('hex'), from: seat.id, to: seat.id, status: 'queued', createdAt: now,
          text: assistantMessageText({ messageId, from: self.name, body: call.message }) });
        // Recorded as received from the chief, so the new bot answers it with reply_to.
        created.inbox!.recent = [{ id: messageId, from: self.key, hop: 1, operationId: call.operationId }];
      }
      teams.push(created);
      return created;
    });
    await this.broker.provision(team.id, team.members[0]!.id).catch(() => undefined);
    await this.inboxes.place(hostId);
    const placed = !this.broker.ports.read().find(item => item.id === team.id)?.inbox?.pending;
    return { botId: team.inbox!.botId, status: placed ? 'ready' : 'waiting',
      message: placed ? `Bot "${call.name}" is ready in your group; it reads its mission first and reports in.` : `Bot "${call.name}" is recorded; its session starts when this computer can create it.` };
  }
  /**
   * The person keeps a temporary bot (bots design 10): its session becomes a standing bot of its chief's group, with its brief as
   * its mission and the chief recorded, and its task ends as done. Its work and conversation stay where they are.
   */
  async keep(teamId: string): Promise<SavedTeam> {
    const team = this.broker.ports.read().find(item => item.id === teamId && item.task) ?? fail('No temporary bot has that id.');
    const worker = team.members[0]!, chief = this.chiefOf(this.temporary(team));
    if (!worker.nativeSessionId || worker.creation !== 'ready') fail('This bot has no session to keep yet.');
    const group = chief?.standing ?? fail('Only a bot of a group can keep its staff; this one\'s chief is not in one.');
    const placeBot = this.ports.placeBot ?? fail('Standing bots cannot be created on this Relay.');
    const botId = newBotId(), name = team.task!.title.slice(0, 60);
    await placeBot(group.groupId, { id: `bot-${botId.slice(2, 14)}`, binding: { hostId: worker.hostId, providerId: worker.providerId, nativeSessionId: worker.nativeSessionId!, title: name } },
      { botId, name, mission: team.task!.brief.slice(0, 4000), chief: chief!.key });
    return this.broker.change(teams => {
      const current = teams.find(item => item.id === teamId)!;
      if (current.task!.state === 'working' || current.task!.state === 'needs_input') taskAction(current, 'mark_task_done', this.broker.ports.now());
      return current;
    });
  }
  /** A standing bot records a lasting change to how it works in its own mission (bots design 2.3). */
  async updateMission(hostId: string, call: Call<'update_mission'>) {
    const self = this.caller(hostId, call.owner).standing ?? fail('A temporary bot\'s mission is its brief; tell your chief what changed instead.');
    const setMission = this.ports.setMission ?? fail('Missions cannot be changed on this Relay.');
    await setMission(self.groupId, self.viewId, call.mission);
    await this.inboxes.known(self, call.mission);
    return { mission: call.mission };
  }
  /** A standing bot keeps its work items and timers (bots design 6); a temporary bot's work is its brief. */
  async keepWork(hostId: string, call: Call<'update_work' | 'complete_work' | 'set_timer'>) {
    const self = this.caller(hostId, call.owner).standing ?? fail('A temporary bot\'s work is its brief; report progress to your chief with message.');
    if (call.action === 'update_work') return this.work.update(self, call);
    if (call.action === 'complete_work') return this.work.complete(self, call);
    return this.work.setTimer(self, call);
  }
  /** Sends one message and says what became of it (bots design 3.2). A refusal is an outcome the sender reads, not an error. */
  async message(hostId: string, call: Call<'bot_message'>): Promise<BotMessageResult> {
    const from = this.caller(hostId, call.owner), chief = this.chiefOf(from);
    // A room the sender is a member of: its turn's answer, a pass, or the room's result.
    const room = this.rooms.memberRoom(hostId, call.owner, call.to);
    if (room) {
      await this.rooms.speak(hostId, call.pass ? { action: 'room_pass', owner: call.owner, roomId: room.id }
        : { action: 'room_say', owner: call.owner, roomId: room.id, text: call.text, ...(call.status === 'done' ? { done: true } : {}) });
      return { outcome: 'delivered' };
    }
    const to = fold(call.to) === 'chief' && chief ? chief : this.named(call.to, from);
    if (to === 'self') return { outcome: 'forbidden', reason: 'You cannot message yourself.' };
    if (!to) return { outcome: 'unreachable', reason: NOT_FOUND };
    return this.route(hostId, from, chief, to, call);
  }
  /** Sends where the sender and receiver say, and marks the messages a standing sender answered by it (bots design 3.3). */
  private async route(hostId: string, from: Bot, chief: Bot | undefined, to: Bot, call: SendCall): Promise<BotMessageResult> {
    const result = await this.send(hostId, from, chief, to, call);
    // The turn answered its sender by this message, or this message names the one it answers.
    const answers = [...call.replyTo ? [call.replyTo] : [], ...call.cause?.kind === 'framed' && call.cause.answers ? [call.cause.answers] : []];
    if (from.standing && answers.length && (result.outcome === 'delivered' || result.outcome === 'held')) await this.inboxes.answered(from.standing, answers, to.key);
    return result;
  }
  /** Where a message goes by who sends it to whom, and the outcome. */
  private async send(hostId: string, from: Bot, chief: Bot | undefined, to: Bot, call: SendCall): Promise<BotMessageResult> {
    // A temporary bot to its chief: its report, its question or its progress.
    if (from.task && chief && to.key === chief.key) {
      const memberId = from.task.members[0]!.id;
      const send = () => call.status === 'done' || call.status === 'failed'
        ? this.tasks.report(hostId, { action: 'report_task', teamId: from.task!.id, memberId, status: call.status, summary: call.patch ? `${call.text}\n\n${call.patch}` : call.text })
        : call.status === 'needs_input' ? this.tasks.ask(hostId, { action: 'ask_owner', teamId: from.task!.id, memberId, question: call.text })
          : this.tasks.progress(hostId, { teamId: from.task!.id, memberId, operationId: call.operationId, text: call.text });
      return this.queued(from.task.id, from.task.members[1]!.id, send);
    }
    if (to.task) {
      const team = this.broker.ports.read().find(item => item.id === to.task!.id);
      if (!team || !running(team)) return { outcome: 'unreachable', reason: 'That bot has finished its work.' };
      const mine = this.staff(hostId, call.owner).some(item => item.id === team.id);
      const worker = team.members[0]!.id;
      return this.queued(team.id, worker, () => mine ? this.tasks.message(hostId, { action: 'message_task', owner: call.owner, taskId: team.id, operationId: call.operationId, text: call.text })
        : this.tasks.input(team.id, from.name, { operationId: call.operationId, text: call.text }));
    }
    return this.messages.deliver(from.standing ?? { key: from.key, name: from.name }, to.standing!, { operationId: call.operationId, text: call.text, ...(call.replyTo ? { replyTo: call.replyTo } : {}) });
  }
  /** Runs a send that queues one input for a member of a task's Team: delivered when it was queued for a ready seat, held when the seat is not ready, duplicate when nothing new was queued. */
  private async queued(teamId: string, memberId: string, send: () => Promise<unknown>): Promise<BotMessageResult> {
    const waiting = () => this.broker.ports.read().find(item => item.id === teamId)?.messages.filter(message => message.to === memberId).length ?? 0;
    const before = waiting();
    await send();
    if (waiting() === before) return { outcome: 'duplicate' };
    const seat = this.broker.ports.read().find(item => item.id === teamId)?.members.find(member => member.id === memberId);
    return { outcome: seat?.creation === 'ready' ? 'delivered' : 'held' };
  }
  /**
   * A standing bot's turn ended with a final text, and one message from another bot started it (bots design 3.3): the text goes
   * back to that message's sender as the reply, cut where a bot's message is cut. Nothing is sent when the turn already answered.
   */
  async reply(hostId: string, call: Call<'bot_reply'>): Promise<BotMessageResult> {
    const from = this.caller(hostId, call.owner), standing = from.standing;
    const entry = standing && this.inboxes.current(this.broker.ports.read(), standing)?.inbox?.recent?.find(item => item.id === call.cause.answers);
    if (!entry) return { outcome: 'forbidden', reason: 'No message of yours has that id.' };
    if (entry.answered) return { outcome: 'duplicate', reason: 'This turn already answered it.' };
    const to = this.byKey(entry.from);
    if (!to) return { outcome: 'unreachable', reason: 'The sender is gone.' };
    return this.route(hostId, from, undefined, to, { owner: call.owner, operationId: `reply-${entry.id}`, text: cutReply(call.text, from.name), replyTo: entry.id, cause: call.cause });
  }
  /** The bot an id means: a standing bot, or a temporary bot still at work. */
  private byKey(key: string): Bot | undefined {
    const standing = accountDirectory(this.ports.groups()).find(item => item.key === key && key.startsWith('b_'));
    if (standing) return { key: standing.key, name: standing.name, standing };
    const team = this.broker.ports.read().find(item => item.task && running(item) && temporaryBotId(item.id) === key);
    return team ? this.temporary(team) : undefined;
  }
  list(hostId: string, call: Call<'list_bots'>): { bots: BotListing[]; work?: WorkItem[] } {
    const self = this.caller(hostId, call.owner), chief = this.chiefOf(self);
    const standing = accountDirectory(this.ports.groups()).filter(item => item.key.startsWith('b_') && item.key !== self.key && !item.hidden)
      .map((item): BotListing => ({ id: item.key, name: item.name, kind: 'standing', ...(item.label ? { label: item.label } : {}), ...(item.mission ? { mission: item.mission } : {}) }));
    const mine = this.staff(hostId, call.owner).map((team): BotListing => ({ id: temporaryBotId(team.id), name: team.task!.title, kind: 'temporary', chief: 'you', status: taskView(team).state, mission: team.task!.brief }));
    const above = chief?.task ? [{ id: chief.key, name: chief.name, kind: 'temporary' as const, mission: chief.task.task!.brief }] : [];
    // A standing bot also reads its own work items here.
    const work = self.standing && this.work.items(self.standing);
    return { bots: [...above, ...mine, ...standing], ...(work?.length ? { work } : {}) };
  }
  /** The chief's hold on one of its temporary bots: stop its work, retire it, or read where its session is. */
  async manageStaff(hostId: string, call: Call<'stop_bot' | 'retire_bot' | 'bot_session'>) {
    this.caller(hostId, call.owner);
    const team = this.staff(hostId, call.owner).find(item => temporaryBotId(item.id) === call.bot || fold(item.task!.title) === fold(call.bot))
      ?? fail('None of your staff has that name; list them with list_bots.');
    if (call.action === 'bot_session') {
      const worker = team.members[0]!;
      if (!worker.nativeSessionId || worker.hostId !== hostId) fail('That bot runs on another computer; ask it with message instead.');
      return { providerId: worker.providerId, nativeSessionId: worker.nativeSessionId };
    }
    if (!running(team)) return { botId: temporaryBotId(team.id), status: team.task!.state };
    const done = await this.tasks.finish(hostId, call.action === 'stop_bot' ? { action: 'cancel_task', owner: call.owner, taskId: team.id }
      : { action: 'mark_task_done', owner: call.owner, taskId: team.id, summary: 'Retired by its chief.' });
    return { botId: temporaryBotId(team.id), status: done.state };
  }
}
