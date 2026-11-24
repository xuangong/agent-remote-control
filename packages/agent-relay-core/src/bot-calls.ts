/**
 * Every bot's own calls (bots design 2, 3, 5.1), made as its main session. A standing bot is a bot of the Window groups; a temporary
 * bot is a task, seen as a bot: its name is the task's title, its mission the brief, its chief the task's owner, its session the
 * worker. A message goes where its sender and receiver say: a temporary bot's to its chief is a report, a question or progress;
 * an chief's to its temporary bot, and any other bot's, is input to that task; anything to a standing bot goes to its inbox.
 */
import { createHash, randomUUID } from 'node:crypto';
import { assistantMessageText, attachmentLines, boardItemOpen, BOARD_BRIEF_LIMIT, BOT_SPAN_LIMIT, chiefChangedText, itemTagText, nativeSessionRefKey, taskView, type BoardItem, type BotAttachment, type BotFact, type BotMessageResult, type TeamHostCall, type TaskView, type TeamMember } from '@orchardworks/agent-remote-protocol';
import { accountDirectory, callerAssistant, type Assistant, type AssistantBrokerPorts, type AssistantMessages, type AssistantPorts } from './assistants.js';
import { ownerTasks, taskAction, type TaskGroups } from './tasks.js';
import { ACCOUNT_TEAM_LIMIT, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import { pruneCoordination } from './coordination-retention.js';
import type { BotInboxes } from './inboxes.js';
import type { Rooms } from './rooms.js';
import type { BotWork } from './bot-work.js';
import { heldItem, type BotBoard, type ItemEdit, type ItemNotice } from './bot-board.js';
import { newBotId } from './bot-store.js';
import type { BotAsks } from './bot-asks.js';
import { forgotten, remembered } from './bot-memory.js';
import { temporaryBotId } from './chain-scope.js';
import { cutReply } from './reply-text.js';
import type { AttachmentStore } from './attachments.js';

type Call<A extends TeamHostCall['action']> = Extract<TeamHostCall, { action: A }>;
type Owner = { providerId: string; nativeSessionId: string };
/** A bot as the calls see it. A temporary bot carries its task. */
/** answer: the bot's answer session this caller is, which may read, keep the board and the memory, and answer, nothing more. */
export type Bot = { key: string; name: string; standing?: Assistant; task?: SavedTeam; answer?: SavedTeam };
export interface BotListing { id: string; name: string; label?: string; mission?: string; kind: 'standing' | 'temporary'; chief?: 'you'; status?: TaskView['state'] }
/** An item as a list shows it: where it stands, without its brief. */
const summary = (item: BoardItem) => ({ key: item.key, title: item.title, status: item.status, assignee: item.assignee, ...(item.report ? { report: item.report } : {}) });
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

const fail = (message: string): never => { throw new Error(message); };
const fold = (text: string) => text.trim().toLocaleLowerCase('en');
const running = (team: SavedTeam) => team.status === 'active' && (team.task?.state === 'working' || team.task?.state === 'needs_input');
export { temporaryBotId };
type SendCall = Pick<Call<'bot_message'>, 'owner' | 'operationId' | 'text' | 'status' | 'replyTo' | 'patch' | 'cause' | 'item'> & { tag?: string };
const NOT_FOUND = 'No bot of this account answers to that name. List them with list_bots.';

export class BotCalls {
  constructor(private readonly broker: AssistantBrokerPorts, private readonly ports: AssistantPorts, private readonly tasks: TaskGroups, private readonly messages: AssistantMessages, private readonly inboxes: BotInboxes, private readonly rooms: Rooms, private readonly work: BotWork, private readonly board: BotBoard, private readonly asks: BotAsks) {}
  private key(hostId: string, providerId: string, nativeSessionId: string): string | undefined {
    try { return nativeSessionRefKey(this.broker.ports.resolveSession(hostId, providerId, nativeSessionId)); } catch { return undefined; }
  }
  /** The calling bot's id. */
  callerKey(hostId: string, owner: Owner): string { return this.caller(hostId, owner).key; }
  private temporary(team: SavedTeam): Bot { return { key: temporaryBotId(team.id), name: team.task!.title, task: team }; }
  /** The calling bot: a standing bot whose view shows this session, or a temporary bot whose worker it is. */
  private caller(hostId: string, owner: Owner): Bot {
    if (!this.ports.capable(hostId)) fail('Update the Controller to use bots.');
    // An answer session is its bot's own session: it reads and writes the bot's board and memory as that bot.
    const answer = this.asks.forSession(hostId, owner);
    if (answer) {
      const standing = accountDirectory(this.ports.groups()).find(item => item.key === answer.ask!.botId) ?? fail('This answer session\'s bot is gone.');
      return { key: standing.key, name: standing.name, standing, answer };
    }
    const own = this.key(hostId, owner.providerId, owner.nativeSessionId);
    const worker = own ? this.broker.ports.read().find(team => team.task && team.members[0]!.hostId === hostId && team.members[0]!.nativeSessionId
      && this.key(hostId, team.members[0]!.providerId, team.members[0]!.nativeSessionId) === own) : undefined;
    if (worker) return this.temporary(worker);
    const standing = callerAssistant(this.broker.ports.resolveSession, hostId, owner, accountDirectory(this.ports.groups()));
    return { key: standing.key, name: standing.name, standing };
  }
  /** The calling bot's main session: the calls that coordinate (create, message, staff, mission, timers, chief) are made there, never in an answer session. */
  private main(hostId: string, owner: Owner): Bot {
    const self = this.caller(hostId, owner);
    return self.answer ? fail('An answer session answers with its final text; it does not message or manage bots. Your main session does that.') : self;
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
    const self = this.main(hostId, call.owner);
    // A chief manages at most twelve bots directly, standing and temporary alike (bots design 2.5).
    if (self.standing && this.span(self.standing) >= BOT_SPAN_LIMIT) fail(`You already manage ${BOT_SPAN_LIMIT} bots; retire one, or give some to a sub-chief.`);
    const item = call.item === undefined ? undefined : this.ownItem(self, call.item);
    if (call.lifetime === 'standing') return this.createStanding(hostId, self, call, item);
    const brief = call.message ? `${call.mission}\n\n${call.message}` : call.mission;
    const created = await this.tasks.create(hostId, { action: 'create_task', owner: call.owner, operationId: call.operationId, title: call.name, brief,
      ...(item ? { item: { board: self.key, key: item.key, title: item.title } } : {}),
      ...(call.workspace ? { workspace: call.workspace } : {}), ...(call.commit ? { commit: call.commit } : {}), ...(call.provider ? { provider: call.provider } : {}), ...(call.model ? { model: call.model } : {}) });
    // The item records its assignee and the brief the bot was created with.
    if (item) await this.notify(await this.board.assign(self.standing!, item.key, temporaryBotId(created.taskId), brief.slice(0, BOARD_BRIEF_LIMIT), self.key));
    return { botId: temporaryBotId(created.taskId), status: created.state, message: created.message.replace(/^Task \S+/, `Bot "${call.name}"`) };
  }
  /**
   * A standing bot another bot creates (bots design 2.2): its inbox's seat creates its session where its chief works, with its
   * standing instructions; once ready, it is placed in its chief's group (`BotInboxes.place`). Its first message waits in its inbox.
   */
  private async createStanding(hostId: string, self: Bot, call: Call<'create_bot'>, item?: BoardItem) {
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
      if (call.message || item) {
        const messageId = `m${createHash('sha256').update(JSON.stringify([created.id, self.key, call.operationId])).digest('hex').slice(0, 12)}`;
        created.messages.push({ id: createHash('sha256').update(JSON.stringify(['first-message', created.id])).digest('hex'), from: seat.id, to: seat.id, status: 'queued', createdAt: now,
          text: assistantMessageText({ messageId, from: self.name, body: call.message ?? 'This item is your work.', ...(item ? { tag: itemTagText({ key: item.key, title: item.title, from: self.name }) } : {}) }) });
        // Recorded as received from the chief, so the new bot answers it with reply_to.
        created.inbox!.recent = [{ id: messageId, from: self.key, hop: 1, operationId: call.operationId }];
      }
      teams.push(created);
      return created;
    });
    await this.broker.provision(team.id, team.members[0]!.id).catch(() => undefined);
    await this.inboxes.place(hostId);
    if (item) await this.notify(await this.board.assign(self.standing!, item.key, team.inbox!.botId, (call.message ?? call.mission).slice(0, BOARD_BRIEF_LIMIT), self.key));
    const placed = !this.broker.ports.read().find(entry => entry.id === team.id)?.inbox?.pending;
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
    const self = this.main(hostId, call.owner).standing ?? fail('A temporary bot\'s mission is its brief; tell your chief what changed instead.');
    const setMission = this.ports.setMission ?? fail('Missions cannot be changed on this Relay.');
    await setMission(self.groupId, self.viewId, call.mission);
    await this.inboxes.known(self, { mission: call.mission });
    return { mission: call.mission };
  }
  /** A standing bot keeps its own memory: the caller's own, never another bot's. */
  private async keepMemory(hostId: string, owner: Owner, change: (memory: readonly BotFact[]) => { memory: BotFact[]; fact: BotFact }) {
    const self = this.caller(hostId, owner).standing ?? fail('A temporary bot has no memory; tell your chief what you learned instead.');
    const setMemory = this.ports.setMemory ?? fail('Memory cannot be changed on this Relay.');
    const { memory, fact } = change(self.memory ?? []);
    await setMemory(self.groupId, self.viewId, memory);
    await this.inboxes.known(self, { memory });
    return { fact, count: memory.length };
  }
  remember(hostId: string, call: Call<'remember'>) { return this.keepMemory(hostId, call.owner, memory => remembered(memory, call.text, call.replace)); }
  forget(hostId: string, call: Call<'forget'>) { return this.keepMemory(hostId, call.owner, memory => forgotten(memory, call.fact)); }
  /** The bots one chief manages directly: its standing bots and its temporary bots at work. */
  private span(chief: Assistant): number {
    return accountDirectory(this.ports.groups()).filter(item => item.chief === chief.key).length + this.staff(chief.hostId, { providerId: chief.providerId, nativeSessionId: chief.nativeSessionId }).filter(running).length;
  }
  /**
   * Moves a standing bot to another chief (a standing bot) or to the person (undefined). The old chief, the new chief and the bot are
   * each told, from the record. The new chief's span counts the bot; a thirteenth is refused. The caller has checked who may ask.
   */
  private async moveChief(bot: Assistant, to: Assistant | undefined): Promise<{ bot: string; chief: string }> {
    const setChief = this.ports.setChief ?? fail('Chiefs cannot be changed on this Relay.');
    const directory = accountDirectory(this.ports.groups());
    if (to?.key === bot.key) fail('A bot cannot be its own chief.');
    for (let above = to; above; above = directory.find(item => item.key === above!.chief)) if (above.chief === bot.key) fail('A bot cannot report to its own staff.');
    const old = bot.chief ? directory.find(item => item.key === bot.chief) : undefined;
    if (bot.chief === to?.key) return { bot: bot.name, chief: to?.name ?? 'the person' };
    if (to && this.span(to) >= BOT_SPAN_LIMIT) fail(`${to.name} already manages ${BOT_SPAN_LIMIT} bots; create a sub-chief for some of them, or choose another chief.`);
    await setChief(bot.key, to?.key ?? null);
    const names = { bot: bot.name, from: old?.name ?? 'the person', chief: to?.name ?? 'the person' }, at = this.broker.ports.now();
    const told: Array<[Assistant | undefined, 'bot' | 'old' | 'new']> = [[bot, 'bot'], [old, 'old'], [to, 'new']];
    for (const [receiver, role] of told) if (receiver) await this.messages.notice(receiver, ['chief', bot.key, role, at], chiefChangedText({ ...names, to: role })).catch(() => undefined);
    return { bot: bot.name, chief: names.chief };
  }
  /** A standing bot's chief moves one of its staff to another chief, or to the person (chief: person). */
  async setChief(hostId: string, call: Call<'set_chief'>) {
    const caller = this.main(hostId, call.owner), self = caller.standing ?? fail('Only a standing bot that is a chief moves its staff.');
    const named = this.named(call.bot, caller);
    const bot = typeof named === 'object' ? named.standing : undefined;
    if (!bot || bot.chief !== self.key) fail('You move your own standing staff only; list them with list_bots.');
    let to: Assistant | undefined;
    if (fold(call.chief) !== 'person') {
      const target = this.named(call.chief, caller);
      to = target === 'self' ? self : typeof target === 'object' ? target.standing : undefined;
      if (!to) fail('A standing bot\'s chief is another standing bot or the person.');
    }
    return this.moveChief(bot!, to);
  }
  /** The person moves a standing bot to a chief, or to themselves (null). */
  async personSetChief(botId: string, chief: string | null) {
    const directory = accountDirectory(this.ports.groups());
    const bot = directory.find(item => item.key === botId && item.key.startsWith('b_')) ?? fail('No standing bot of this account has that id.');
    const to = chief === null ? undefined : directory.find(item => item.key === chief && item.key.startsWith('b_')) ?? fail('No standing bot of this account has that id.');
    return this.moveChief(bot, to);
  }
  /** A standing bot keeps its named timers (bots design 6.2); a temporary bot reports to its chief instead. */
  async setTimer(hostId: string, call: Call<'set_timer'>) {
    const self = this.main(hostId, call.owner).standing ?? fail('A temporary bot\'s work is its brief; report progress to your chief with message.');
    return this.work.setTimer(self, call);
  }
  /** The item of the caller's own board a bot is handed work with. */
  private ownItem(self: Bot, key: number): BoardItem {
    const standing = self.standing ?? fail('A temporary bot has no board; its chief\'s board holds its item.');
    return this.board.read(standing)?.items.find(entry => entry.key === key) ?? fail(`No item ${key} on your board; read it with board.`);
  }
  /** The standing bot whose board this is. */
  private boardOwner(key: string): Assistant { return accountDirectory(this.ports.groups()).find(item => item.key === key) ?? fail('The board belongs to a bot that is gone.'); }
  /** Reads a board (bots design 6.1): one's own, or that of a standing bot one is chief of, which is read only; a temporary bot reads its item. */
  readBoard(hostId: string, call: Call<'board'>) {
    const self = this.caller(hostId, call.owner);
    let target: Assistant, name = self.name;
    if (call.bot) {
      const named = this.named(call.bot, self);
      if (named === 'self') { target = self.standing ?? fail('A temporary bot has no board.'); }
      else { const staff = typeof named === 'object' ? named.standing : undefined; if (!staff || staff.chief !== self.key) fail('You read the board of your own standing staff only.'); target = staff!; name = staff!.name; }
    } else if (self.standing) target = self.standing;
    else { const ref = self.task!.task!.item ?? fail('This bot was not created for a board item.'); target = this.boardOwner(ref.board); call = { ...call, item: ref.key }; name = target.name; }
    const board = this.board.read(target), items = board?.items ?? [];
    const readOnly = target.key !== self.key;
    if (call.item !== undefined) return { bot: name, item: items.find(entry => entry.key === call.item) ?? fail(`No item ${call.item} on that board.`), ...(readOnly ? { readOnly } : {}) };
    const ordered = [...items.filter(entry => boardItemOpen(entry.status)), ...items.filter(entry => !boardItemOpen(entry.status))];
    return { bot: name, ...(board?.plan ? { plan: board.plan } : {}), items: ordered.map(entry => ({ ...entry, ...(entry.brief ? { brief: clip(entry.brief, 120) } : {}) })), ...(readOnly ? { readOnly } : {}) };
  }
  /** Writes the caller's own board, or the item a temporary bot was created for; the bots it hands work away to are told what changed. */
  async updateBoard(hostId: string, call: Call<'update_board'>) {
    const self = this.caller(hostId, call.owner);
    const edits = (call.items ?? []).map((edit): ItemEdit => ({ ...edit, ...(edit.assignee !== undefined ? { assignee: this.assignee(hostId, call.owner, edit.assignee, self) } : {}) }));
    const written = self.standing
      ? await this.board.write(self.standing, edits, call.plan, self.key)
      : await this.writeOwnItem(self, edits, call.plan);
    await this.notify(written.notices.filter(notice => notice.to !== self.key));
    return { items: written.items, ...(written.plan ? { plan: written.plan } : {}) };
  }
  private writeOwnItem(self: Bot, edits: ItemEdit[], plan: unknown) {
    const ref = self.task!.task!.item ?? fail('This bot was not created for a board item; report to your chief with message.');
    if (plan) fail('A temporary bot does not write the plan note.');
    return this.board.write(this.boardOwner(ref.board), edits, undefined, self.key, ref.key);
  }
  /** Who an item is assigned to: self, a standing bot, or one of the caller's temporary bots, by name or id. */
  private assignee(hostId: string, owner: Owner, name: string, caller: Bot): string {
    if (fold(name) === 'self' || caller.task) return 'self';
    const bot = this.named(name, caller);
    if (bot === 'self') return 'self';
    if (!bot || (bot.task && !this.staff(hostId, owner).some(team => team.id === bot.task!.id))) return fail(NOT_FOUND);
    return bot.key;
  }
  /** Tells bots what changed on an item they hold: written from the record, so a bot that is gone or finished simply is not told. */
  private async notify(notices: readonly ItemNotice[]): Promise<void> {
    for (const notice of notices) {
      const to = this.byKey(notice.to);
      if (!to) continue;
      await (to.standing ? this.messages.notice(to.standing, notice.key, notice.text) : this.tasks.notice(to.task!.id, notice.key, notice.text)).catch(() => undefined);
    }
  }
  private files(): AttachmentStore { return this.broker.ports.attachments ?? fail('This Relay does not take attachments.'); }
  /** A bot's files: uploaded in chunks and finished, then read back by the bots a message names them to (bots design 3.4). */
  async attachment(hostId: string, call: Call<'attachment_begin' | 'attachment_chunk' | 'attachment_finish' | 'attachment_read'>) {
    this.caller(hostId, call.owner);
    const files = this.files();
    if (call.action === 'attachment_begin') return files.begin({ name: call.name, mediaType: call.mediaType, byteLength: call.byteLength, sha256: call.sha256 });
    if (call.action === 'attachment_finish') return files.finish(call.attachment);
    if (call.action === 'attachment_chunk') {
      const bytes = Buffer.from(call.contentBase64, 'base64');
      if (bytes.toString('base64') !== call.contentBase64) fail('Invalid file chunk.');
      return files.chunk(call.attachment, call.offset, bytes);
    }
    const chunk = await files.read(call.attachment, call.offset);
    return { attachment: chunk.attachment, offset: chunk.offset, contentBase64: Buffer.from(chunk.bytes).toString('base64') };
  }
  /** Sends one message and says what became of it (bots design 3.2). A refusal is an outcome the sender reads, not an error. */
  async message(hostId: string, call: Call<'bot_message'>): Promise<BotMessageResult> {
    const from = this.caller(hostId, call.owner), chief = this.chiefOf(from);
    if (from.answer) return { outcome: 'forbidden', reason: 'An answer session answers with its final text; it does not message bots.' };
    // A room the sender is a member of: its turn's answer, a pass, or the room's result.
    const room = this.rooms.memberRoom(hostId, call.owner, call.to);
    if (room) {
      if (call.attachments) fail('A room message cannot carry files.');
      await this.rooms.speak(hostId, call.pass ? { action: 'room_pass', owner: call.owner, roomId: room.id }
        : { action: 'room_say', owner: call.owner, roomId: room.id, text: call.text, ...(call.status === 'done' ? { done: true } : {}) });
      return { outcome: 'delivered' };
    }
    const to = fold(call.to) === 'chief' && chief ? chief : this.named(call.to, from);
    if (to === 'self') return { outcome: 'forbidden', reason: 'You cannot message yourself.' };
    if (!to) return { outcome: 'unreachable', reason: NOT_FOUND };
    // The files the message carries are listed after the sender's words, written from their records.
    const files: BotAttachment[] = call.attachments ? await Promise.all(call.attachments.map(id => this.files().metadata(id))) : [];
    const text = files.length ? `${call.text}\n${attachmentLines(files)}` : call.text;
    // A message with a status to the bot whose board holds an item assigned to the sender is a report on that item; any other message
    // naming an item hands work away on one of the sender's own.
    const held = call.status !== undefined && to.standing ? heldItem(this.board.read(to.standing), from.key, call.item ?? from.task?.task?.item?.key) : undefined;
    if (call.item !== undefined && !held && from.standing) {
      const item = this.board.read(from.standing)?.items.find(entry => entry.key === call.item);
      if (!item) return { outcome: 'forbidden', reason: `No item ${call.item} on your board; read it with board.` };
      const result = await this.route(hostId, from, chief, to, { ...call, text, tag: itemTagText({ key: item.key, title: item.title, from: from.name }) });
      if (result.outcome === 'delivered' || result.outcome === 'held') await this.notify(await this.board.assign(from.standing, item.key, to.key, call.text, from.key));
      return result;
    }
    const result = await this.route(hostId, from, chief, to, { ...call, text, ...(held && !from.task ? { tag: itemTagText({ key: held.key, title: held.title, from: from.name }) } : {}) });
    // The report is the item's latest, whoever made it; its status follows only when the assignee is the bot created for the item.
    if (held && to.standing && (result.outcome === 'delivered' || result.outcome === 'held')) await this.board.report(to.standing, from.key, held.key, call.status, call.text, from.task?.task?.item?.board === to.key);
    return result;
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
      return this.queued(team.id, worker, () => mine ? this.tasks.message(hostId, { action: 'message_task', owner: call.owner, taskId: team.id, operationId: call.operationId, text: call.text }, call.tag)
        : this.tasks.input(team.id, from.name, { operationId: call.operationId, text: call.text, ...(call.tag ? { tag: call.tag } : {}) }));
    }
    return this.messages.deliver(from.standing ?? { key: from.key, name: from.name }, to.standing!, { operationId: call.operationId, text: call.text, ...(call.replyTo ? { replyTo: call.replyTo } : {}), ...(call.tag ? { tag: call.tag } : {}) });
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
    const from = this.main(hostId, call.owner), standing = from.standing;
    const entry = standing && this.inboxes.current(this.broker.ports.read(), standing)?.inbox?.recent?.find(item => item.id === call.cause.answers);
    if (!entry) return { outcome: 'forbidden', reason: 'No message of yours has that id.' };
    if (entry.answered) return { outcome: 'duplicate', reason: 'This turn already answered it.' };
    const to = this.byKey(entry.from);
    if (!to) return { outcome: 'unreachable', reason: 'The sender is gone.' };
    return this.route(hostId, from, undefined, to, { owner: call.owner, operationId: `reply-${entry.id}`, text: cutReply(call.text, from.name), replyTo: entry.id, cause: call.cause });
  }
  /**
   * The person wrote into a standing bot's session (bots design 3.5): its chief, when a bot, reads the first 300 characters framed
   * as what they are. Nothing is queued for a bot whose chief is the person, who already sees it.
   */
  async told(hostId: string, call: Call<'bot_told'>): Promise<BotMessageResult> {
    const self = this.caller(hostId, call.owner), bot = self.standing;
    if (self.answer) return { outcome: 'forbidden', reason: 'The person asks an answer session; nobody else needs to hear it.' };
    if (!bot) return { outcome: 'forbidden', reason: 'A temporary bot\'s chief hears the person through its task.' };
    const chief = bot.chief ? this.byKey(bot.chief) : undefined;
    if (!chief?.standing) return { outcome: 'unreachable', reason: 'The person is its chief, or its chief is gone.' };
    return this.messages.deliver(bot, chief.standing, { operationId: call.cause.messageId, text: call.text, frame: 'person' });
  }
  /** The bot an id means: a standing bot, or a temporary bot still at work. */
  private byKey(key: string): Bot | undefined {
    const standing = accountDirectory(this.ports.groups()).find(item => item.key === key && key.startsWith('b_'));
    if (standing) return { key: standing.key, name: standing.name, standing };
    const team = this.broker.ports.read().find(item => item.task && running(item) && temporaryBotId(item.id) === key);
    return team ? this.temporary(team) : undefined;
  }
  list(hostId: string, call: Call<'list_bots'>) {
    const self = this.caller(hostId, call.owner), chief = this.chiefOf(self);
    const standing = accountDirectory(this.ports.groups()).filter(item => item.key.startsWith('b_') && item.key !== self.key && !item.hidden)
      .map((item): BotListing => ({ id: item.key, name: item.name, kind: 'standing', ...(item.label ? { label: item.label } : {}), ...(item.mission ? { mission: item.mission } : {}) }));
    const mine = this.staff(hostId, call.owner).map((team): BotListing => ({ id: temporaryBotId(team.id), name: team.task!.title, kind: 'temporary', chief: 'you', status: taskView(team).state, mission: team.task!.brief }));
    const above = chief?.task ? [{ id: chief.key, name: chief.name, kind: 'temporary' as const, mission: chief.task.task!.brief }] : [];
    // A standing bot also reads where its open board items stand here.
    const open = (self.standing && this.board.read(self.standing)?.items.filter(entry => boardItemOpen(entry.status)).map(summary)) || [];
    return { bots: [...above, ...mine, ...standing], ...(open.length ? { board: { open: open.length, items: open } } : {}) };
  }
  /** Where a bot's conversation is, for `read_bot`: one of the caller's staff, or any standing bot of the account (the person's bots are not secret from each other). */
  readSession(hostId: string, call: Call<'bot_session'>): { providerId: string; nativeSessionId: string } {
    const self = this.caller(hostId, call.owner);
    // An answer session reads the conversation it was asked from ("asking") and its bot's main session ("main").
    const own = self.answer && fold(call.bot) === 'asking' ? self.answer.ask!.from : self.answer && fold(call.bot) === 'main' ? self.standing : undefined;
    const team = this.staff(hostId, call.owner).find(item => temporaryBotId(item.id) === call.bot || fold(item.task!.title) === fold(call.bot));
    const found = own ?? team?.members[0] ?? (() => { const bot = this.named(call.bot, self); return typeof bot === 'object' ? bot.standing : undefined; })();
    if (!found?.nativeSessionId || found.hostId !== hostId) fail(found ? 'That bot runs on another computer; ask it with message instead.' : NOT_FOUND);
    const current = this.broker.ports.resolveSession(found!.hostId, found!.providerId, found!.nativeSessionId!);
    return { providerId: current.providerId, nativeSessionId: current.nativeSessionId };
  }
  /** The chief's hold on one of its temporary bots: stop its work, retire it. */
  async manageStaff(hostId: string, call: Call<'stop_bot' | 'retire_bot'>) {
    this.main(hostId, call.owner);
    const team = this.staff(hostId, call.owner).find(item => temporaryBotId(item.id) === call.bot || fold(item.task!.title) === fold(call.bot))
      ?? fail('None of your staff has that name; list them with list_bots.');
    if (!running(team)) return { botId: temporaryBotId(team.id), status: team.task!.state };
    const done = await this.tasks.finish(hostId, call.action === 'stop_bot' ? { action: 'cancel_task', owner: call.owner, taskId: team.id }
      : { action: 'mark_task_done', owner: call.owner, taskId: team.id, summary: 'Retired by its chief.' });
    return { botId: temporaryBotId(team.id), status: done.state };
  }
}
