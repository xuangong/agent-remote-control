/**
 * Every bot's own calls (bots design 2, 3, 5.1), made as its main session. A standing bot is a bot of the Window groups. A sub-session is
 * a working session of a bot, not a bot: it is named by an id that no bot lookup resolves, it is reached only by its bot's own calls and
 * the person, and it reads and writes its bot's board and reports with `communicate_update`. A message goes to a bot; anything to a
 * standing bot goes to its inbox.
 */
import { createHash, randomUUID } from 'node:crypto';
import { type ChainAction, workLogLine, assistantMessageText, attachmentLines, boardItemOpen, BOARD_BRIEF_LIMIT, BOT_SPAN_LIMIT, chiefChangedText, itemTagText, nativeSessionRefKey, taskView, type BoardItem, type BoardItemEdit, type BoardLink, type BoardPlanEdit, type BotAttachment, type BotFact, type BotMessageResult, type TeamHostCall, type TaskView, type TeamMember } from '@orchardworks/agent-remote-protocol';
import { accountDirectory, callerAssistant, sessionAssistant, type Assistant, type AssistantBrokerPorts, type AssistantMessages, type AssistantPorts } from './assistants.js';
import { botLive, ownerTasks, taskAction, type TaskGroups } from './tasks.js';
import { ACCOUNT_TEAM_LIMIT, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import { pruneCoordination } from './coordination-retention.js';
import type { BotInboxes } from './inboxes.js';
import type { Rooms } from './rooms.js';
import type { BotRoutines, RoutineSpec } from './routines.js';
import { pageList, type BotPages } from './bot-pages.js';
import { heldItem, type BotBoard, type ItemEdit, type ItemNotice } from './bot-board.js';
import { newBotId } from './bot-store.js';
import type { BotAsks } from './bot-asks.js';
import { forgotten, remembered } from './bot-memory.js';
import { subSessionId } from './chain-scope.js';
import { cutReply } from './reply-text.js';
import type { AttachmentStore } from './attachments.js';
import type { HostPlaces } from './host-places.js';

type Call<A extends TeamHostCall['action']> = Extract<TeamHostCall, { action: A }>;
type Owner = { providerId: string; nativeSessionId: string };
/** A bot as the calls see it. A sub-session carries its Team (`task`) and is no bot: it makes only the calls it is given. */
/** answer: the bot's answer session this caller is, which may read, keep the board and the memory, and answer, nothing more. */
export type Bot = { key: string; name: string; standing?: Assistant; task?: SavedTeam; answer?: SavedTeam };
export interface BotListing { id: string; name: string; label?: string; mission?: string; primary?: true }
/** An item as a list shows it: where it stands, without its brief. */
const summary = (item: BoardItem) => ({ key: item.key, title: item.title, status: item.status, assignee: item.assignee, ...(item.report ? { report: item.report } : {}) });
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

const fail = (message: string): never => { throw new Error(message); };
/** What an item records of where its bot works, and what the creating call returns of it. */
const placeLinks = (place?: { name: string; cwd: string }): BoardLink[] => place ? [{ kind: 'host', value: place.name.slice(0, 300) }, { kind: 'folder', value: place.cwd.slice(0, 300) }] : [];
const placeResult = (place?: { name: string; cwd: string }) => place ? { host: place.name, folder: place.cwd } : {};
const fold = (text: string) => text.trim().toLocaleLowerCase('en');
const running = (team: SavedTeam) => team.status === 'active' && (team.task?.state === 'working' || team.task?.state === 'needs_input');
export { subSessionId };
type SendCall = Pick<Call<'bot_message'>, 'owner' | 'operationId' | 'text' | 'status' | 'replyTo' | 'patch' | 'cause' | 'item'> & { tag?: string; final?: boolean };
const NOT_FOUND = 'No bot of this account answers to that name. List them with list_bots.';

export class BotCalls {
  constructor(private readonly broker: AssistantBrokerPorts, private readonly ports: AssistantPorts, private readonly tasks: TaskGroups, private readonly messages: AssistantMessages, private readonly inboxes: BotInboxes, private readonly rooms: Rooms, private readonly work: BotRoutines, private readonly board: BotBoard, private readonly asks: BotAsks, private readonly pages: BotPages, private readonly places?: HostPlaces) {}
  private key(hostId: string, providerId: string, nativeSessionId: string): string | undefined {
    try { return nativeSessionRefKey(this.broker.ports.resolveSession(hostId, providerId, nativeSessionId)); } catch { return undefined; }
  }
  /** The calling bot's id. */
  callerKey(hostId: string, owner: Owner): string { return this.caller(hostId, owner).key; }
  private subSession(team: SavedTeam): Bot { return { key: subSessionId(team.id), name: team.task!.title, task: team }; }
  /** The caller: a standing bot whose view shows this session, or a sub-session whose session it is. */
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
    if (worker) return this.subSession(worker);
    const standing = callerAssistant(this.broker.ports.resolveSession, hostId, owner, accountDirectory(this.ports.groups()));
    return { key: standing.key, name: standing.name, standing };
  }
  /** The calling bot's main session: the calls that coordinate (create, message, staff, mission, timers, chief) are made there, never in an answer session. */
  private main(hostId: string, owner: Owner): Bot {
    const self = this.caller(hostId, owner);
    if (self.task) fail('A sub-session is not a bot: it reports with communicate_update and writes the items it owns.');
    return self.answer ? fail('An answer session answers with its final text; it does not message or manage bots. Your main session does that.') : self;
  }
  /** The standing bot a sub-session belongs to: the bot whose main session owns it. */
  private ownerOf(bot: Bot): Bot | undefined {
    if (!bot.task) return undefined;
    const seat = bot.task.members[1]!, key = this.key(seat.hostId, seat.providerId, seat.nativeSessionId!);
    const standing = sessionAssistant(accountDirectory(this.ports.groups()).filter(item => this.key(item.hostId, item.providerId, item.nativeSessionId) === key));
    return standing ? { key: standing.key, name: standing.name, standing } : undefined;
  }
  /** The sub-sessions a bot's session owns. */
  private staff(hostId: string, owner: Owner): SavedTeam[] { return ownerTasks(this.broker.ports.read(), this.broker.ports.resolveSession, hostId, owner); }
  /** The standing bot a name or id means. A sub-session is never one of them. */
  private named(name: string, caller: Bot): Bot | 'self' | undefined {
    const standing = accountDirectory(this.ports.groups()).filter(item => item.key.startsWith('b_')).map((item): Bot => ({ key: item.key, name: item.name, standing: item }));
    const matches = standing.filter(bot => bot.key === name || fold(bot.name) === fold(name));
    if (matches.length !== 1) return undefined;
    return matches[0]!.key === caller.key ? 'self' : matches[0]!;
  }
  /**
   * Where the bot is to work when the caller chose: its Host and folder, an existing one or a new one created once (a replay of the same
   * operation finds the folder its first call made). Undefined when the caller chose nothing: the bot works beside its chief.
   */
  private async chosenPlace(hostId: string, call: Pick<Call<'create_bot'>, 'host' | 'cwd' | 'newFolder' | 'provider' | 'operationId' | 'owner'> & { workspace?: string }): Promise<{ hostId: string; name: string; cwd: string } | undefined> {
    if (call.host === undefined && call.cwd === undefined && call.newFolder === undefined) return undefined;
    if (call.cwd !== undefined && call.newFolder !== undefined) fail('Give cwd or new_folder, not both.');
    if (call.cwd === undefined && call.newFolder === undefined) {
      if (call.host === undefined || call.host === hostId) return undefined;
      fail('Name the folder the bot works in on that Host: an existing one (cwd) or a new one (new_folder). list_hosts shows them.');
    }
    if (call.workspace === 'worktree') fail('A worktree starts from your own commit; choose a folder with workspace same or read_only.');
    const places = this.places ?? fail('Choosing a Host or folder is not available on this Relay.');
    const target = call.host ?? hostId, providerId = call.provider ?? call.owner.providerId;
    const name = places.name(target);
    const first = this.broker.ports.read().find(team => team.operationId === call.operationId && (team.task || team.inbox))?.members[0];
    if (first?.cwd) return { hostId: first.hostId, name, cwd: first.cwd };
    if (call.cwd !== undefined) { await places.assertFolder(target, providerId, call.cwd); return { hostId: target, name, cwd: call.cwd }; }
    return { hostId: target, name, cwd: await places.createFolder(target, providerId, call.newFolder!.name, call.newFolder!.under) };
  }
  /** A bot recruits a standing bot (bots design 2.2): it reports in, and the person finds it in Chats in its chief's group. */
  async create(hostId: string, call: Call<'create_bot'>) {
    const self = this.main(hostId, call.owner);
    // A chief manages at most twelve bots directly (bots design 2.5).
    if (self.standing && this.span(self.standing) >= BOT_SPAN_LIMIT) fail(`You already manage ${BOT_SPAN_LIMIT} bots; give some to a sub-chief.`);
    const item = call.item === undefined ? undefined : this.ownItem(self, call.item);
    const place = await this.chosenPlace(hostId, call);
    return this.createStanding(hostId, self, call, item, place);
  }
  /** A bot starts a sub-session: a working session of its own, which takes up the board items it names. */
  async createSub(hostId: string, call: Call<'create_sub_session'>) {
    const self = this.main(hostId, call.owner);
    const standing = self.standing ?? fail('Only a standing bot starts sub-sessions.');
    const items = (call.trackedTaskKeys ?? []).map(key => this.ownItem(self, key));
    const place = await this.chosenPlace(hostId, call);
    const first = items[0];
    // What the first item says to do reaches the sub-session in its first input, after the prompt.
    const prompt = [call.prompt, first?.brief].filter((part, index, parts): part is string => !!part && parts.indexOf(part) === index).join('\n\n');
    const created = await this.tasks.create(hostId, { owner: call.owner, operationId: call.operationId, name: call.name, prompt,
      ...(first ? { item: { board: self.key, key: first.key, title: first.title } } : {}),
      ...(call.workspace ? { workspace: call.workspace } : {}), ...(call.commit ? { commit: call.commit } : {}), ...(call.provider ? { provider: call.provider } : {}), ...(call.model ? { model: call.model } : {}), ...(call.fork ? { fork: call.fork } : {}) },
    place ? { where: { hostId: place.hostId, cwd: place.cwd } } : {});
    const id = subSessionId(created.taskId);
    for (const item of items) await this.notify(await this.board.assign(standing, item.key, id, (item.brief ?? prompt).slice(0, BOARD_BRIEF_LIMIT), self.key, [...placeLinks(place), { kind: 'sub_session', value: id }]));
    return { sub_session_id: id, status: created.state, message: created.message.replace(/^Sub-session \S+/, `Sub-session "${call.name}"`) + (call.fork ? ` It starts with the last ${call.fork.turns} turn${call.fork.turns === 1 ? '' : 's'} of your conversation${call.fork.shortened ? ' (some long messages were shortened)' : ''}.` : ''), ...placeResult(place) };
  }
  /** The sub-session of the caller that an id or a name means. */
  private ownSub(hostId: string, call: { owner: Owner; subSessionId: string }): SavedTeam {
    return this.staff(hostId, call.owner).find(team => subSessionId(team.id) === call.subSessionId || fold(team.task!.title) === fold(call.subSessionId))
      ?? fail('None of your sub-sessions has that id or name; list them with get_sub_session_status.');
  }
  /** More work for one of the caller's sub-sessions, delivered between its turns; `unreachable` once it has ended. */
  async sendSub(hostId: string, call: Call<'send_to_sub_session'>) {
    const self = this.main(hostId, call.owner), team = this.ownSub(hostId, call), standing = self.standing!;
    if (team.task!.state === 'ended') return { sub_session_id: subSessionId(team.id), delivered_as: 'unreachable', message: 'This sub-session has ended. Start a new one for more work.' };
    const items = (call.trackedTaskKeys ?? []).map(key => this.ownItem(self, key));
    const first = items[0];
    const before = team.messages.length;
    const result = await this.tasks.send(hostId, { owner: call.owner, teamId: team.id, operationId: call.operationId, text: call.text, title: call.title, ...(call.delivery ? { delivery: call.delivery } : {}),
      ...(first ? { item: { board: self.key, key: first.key, title: first.title } } : {}) }, first ? itemTagText({ key: first.key, title: first.title, from: self.name }) : undefined);
    const id = subSessionId(team.id);
    for (const item of items) await this.notify(await this.board.assign(standing, item.key, id, call.text.slice(0, BOARD_BRIEF_LIMIT), self.key, [{ kind: 'sub_session', value: id }]));
    const after = this.broker.ports.read().find(item => item.id === team.id)!;
    const delivered = after.messages.length === before ? 'duplicate' : after.members[0]!.creation === 'ready' ? 'delivered' : 'held';
    return { sub_session_id: id, delivered_as: delivered, status: result.state, message: delivered === 'duplicate' ? 'That work was already sent.' : 'The sub-session gets it between its turns.' };
  }
  /** The caller's sub-sessions with how each stands: lifecycle, whether a turn runs, the last work and result, and for how long it has been idle. */
  async subStatus(hostId: string, call: Call<'get_sub_session_status'>) {
    this.main(hostId, call.owner);
    const now = this.broker.ports.now();
    const listed = this.tasks.status(hostId, call, team => subSessionId(team.id)).sub_sessions;
    return { sub_sessions: listed.map(view => { const id = subSessionId(view.taskId);
      return { id, name: view.title, lifecycle: view.state === 'queued' ? 'starting' : view.state === 'needs_input' ? 'needs_you' : view.state === 'ended' ? 'ended' : 'live',
        turn_in_flight: view.state === 'working' || view.state === 'queued', ...(view.result ? { last_terminal_turn_status: view.result.outcome } : {}),
        ...(view.lastWork ? { last_work_title: view.lastWork.title } : {}), ...(view.currentStep ? { current_step: view.currentStep } : {}),
        ...(view.result ? { last_result: clip(view.result.text, 300) } : {}), ...(view.waiting ? { waiting: view.waiting.text } : {}),
        last_activity_at_ms: view.updatedAt, ...(view.state === 'idle' ? { idle_for_ms: Math.max(0, now - view.updatedAt) } : {}) }; }),
      message: listed.length ? `${listed.length} sub-session${listed.length === 1 ? '' : 's'}.` : 'You have no sub-sessions.' };
  }
  /** A bot ends one of its sub-sessions: its running turn stops and its session is released; its conversation stays readable. */
  async stopSub(hostId: string, call: Call<'stop_sub_session'>) {
    this.main(hostId, call.owner);
    const team = this.ownSub(hostId, call);
    if (team.task!.state !== 'ended') await this.tasks.stop(hostId, { owner: call.owner, teamId: team.id });
    return { sub_session_id: subSessionId(team.id), message: 'The sub-session has ended; its conversation stays readable.' };
  }
  /** Where one of the caller's own sub-sessions is, by id or name, for `read_sub_session`; no other bot's, and no bot's. */
  readSub(hostId: string, call: Call<'read_sub_session'>): { providerId: string; nativeSessionId: string } {
    this.main(hostId, call.owner);
    const found = this.ownSub(hostId, { owner: call.owner, subSessionId: call.subSessionId }).members[0]!, nativeSessionId = found.nativeSessionId;
    if (!nativeSessionId || found.hostId !== hostId) throw new Error('That sub-session runs on another computer; its result reaches you as input.');
    const current = this.broker.ports.resolveSession(found.hostId, found.providerId, nativeSessionId);
    return { providerId: current.providerId, nativeSessionId: current.nativeSessionId };
  }
  /** Ends the live sub-sessions of a bot that is no longer one: when a bot retires, its sub-sessions end. A person's own sides stay with the person. */
  async endRetired(): Promise<void> {
    const directory = accountDirectory(this.ports.groups());
    if (!directory.length) return;
    const bots = new Set(directory.map(bot => this.key(bot.hostId, bot.providerId, bot.nativeSessionId)));
    const orphans = this.broker.ports.read().filter(team => team.task && team.status === 'active' && team.task.state !== 'ended' && team.task.startedBy !== 'person'
      && !bots.has(this.key(team.members[1]!.hostId, team.members[1]!.providerId, team.members[1]!.nativeSessionId!)));
    if (!orphans.length) return;
    const ids = new Set(orphans.map(team => team.id));
    await this.broker.change(teams => { for (const team of teams) if (ids.has(team.id)) taskAction(team, this.broker.ports.now(), 'bot_retired'); });
  }
  /** A sub-session reports what it is doing now, or the result of the piece of work it finished (communicate_update). */
  async subUpdate(hostId: string, call: Call<'sub_update'>) {
    const self = this.caller(hostId, call.owner), team = self.task ?? fail('Only a sub-session reports with communicate_update.');
    await this.tasks.update(hostId, { teamId: team.id, memberId: team.members[0]!.id, ...(call.currentStep ? { currentStep: call.currentStep } : {}), ...(call.finalSummary ? { finalSummary: call.finalSummary } : {}) });
    return { message: 'Recorded.' };
  }
  /** A sub-session's turn ended: its Host reports how and with what text; its bot reads the result, and the items it owns carry it as their latest report. */
  async subTurnEnd(hostId: string, call: Call<'sub_turn_end'>) {
    const done = await this.tasks.turnEnded(hostId, call);
    const team = this.broker.ports.read().find(item => item.id === call.teamId), result = team?.task?.result;
    const owner = team && this.ownerOf(this.subSession(team));
    if (owner?.standing && result) await this.board.reportOwned(owner.standing, subSessionId(team.id), clip(result.text, 300));
    return done;
  }
  /**
   * A standing bot another bot creates (bots design 2.2): its inbox's seat creates its session where its chief works, with its
   * standing instructions; once ready, it is placed in its chief's group (`BotInboxes.place`). Its first message waits in its inbox.
   */
  private async createStanding(hostId: string, self: Bot, call: Call<'create_bot'>, item?: BoardItem, place?: { hostId: string; name: string; cwd: string }) {
    if (!self.standing) fail('Only a standing bot recruits a standing bot.');
    if (!this.ports.placeBot) fail('Standing bots cannot be created on this Relay.');
    const providerId = call.provider ?? call.owner.providerId, botHost = place?.hostId ?? hostId;
    this.broker.ports.assertHost(botHost, providerId);
    const team = await this.broker.change(teams => {
      const existing = teams.find(item => item.operationId === call.operationId && item.inbox);
      if (existing) return existing;
      pruneCoordination(teams, 1);
      if (plain(teams).length >= ACCOUNT_TEAM_LIMIT) fail('Team capacity reached.');
      const now = this.broker.ports.now(), botId = newBotId();
      const seat: TeamMember = { id: randomUUID(), role: 'leader', hostId: botHost, providerId, name: call.name, responsibility: call.mission.slice(0, 2048), ...(place ? { cwd: place.cwd } : {}), creation: 'reserved', activity: 'unknown',
        summary: '', updatedAt: now, ...(call.model ? { model: call.model } : {}) };
      const created: SavedTeam = { id: randomUUID(), operationId: call.operationId, revision: 1, title: `${call.name}'s inbox`, status: 'active',
        source: { hostId, providerId: call.owner.providerId, nativeSessionId: call.owner.nativeSessionId, title: self.name }, members: [seat], messages: [],
        inbox: { botId, pending: { name: call.name, mission: call.mission, chief: self.key, groupId: self.standing!.groupId } }, createdAt: now, updatedAt: now };
      if (call.message || item) {
        const messageId = `m${createHash('sha256').update(JSON.stringify([created.id, self.key, call.operationId])).digest('hex').slice(0, 12)}`;
        created.messages.push({ id: createHash('sha256').update(JSON.stringify(['first-message', created.id])).digest('hex'), from: seat.id, to: seat.id, status: 'queued', createdAt: now,
          text: assistantMessageText({ messageId, from: self.name, body: [call.message, item?.brief].filter((part, index, parts): part is string => !!part && parts.indexOf(part) === index).join('\n\n') || 'This item is your work.', ...(item ? { tag: itemTagText({ key: item.key, title: item.title, from: self.name }) } : {}) }) });
        // Recorded as received from the chief, so the new bot answers it with reply_to.
        created.inbox!.recent = [{ id: messageId, from: self.key, hop: 1, operationId: call.operationId }];
      }
      teams.push(created);
      return created;
    });
    await this.broker.provision(team.id, team.members[0]!.id).catch(() => undefined);
    await this.inboxes.place(botHost);
    if (item) await this.notify(await this.board.assign(self.standing!, item.key, team.inbox!.botId, (item?.brief ?? call.message ?? call.mission).slice(0, BOARD_BRIEF_LIMIT), self.key, placeLinks(place)));
    const placed = !this.broker.ports.read().find(entry => entry.id === team.id)?.inbox?.pending;
    return { botId: team.inbox!.botId, status: placed ? 'ready' : 'waiting', ...placeResult(place),
      message: placed ? `Bot "${call.name}" is ready in your group; it reads its mission first and reports in.` : `Bot "${call.name}" is recorded; its session starts when this computer can create it.` };
  }
  /** A standing bot records a lasting change to how it works in its own mission (bots design 2.3). */
  async updateMission(hostId: string, call: Call<'update_mission'>) {
    const self = this.main(hostId, call.owner).standing ?? fail('Only a standing bot has a mission.');
    const setMission = this.ports.setMission ?? fail('Missions cannot be changed on this Relay.');
    await setMission(self.groupId, self.viewId, call.mission);
    await this.inboxes.known(self, { mission: call.mission });
    return { mission: call.mission };
  }
  /** A standing bot keeps its own memory: the caller's own, never another bot's. */
  private async keepMemory(hostId: string, owner: Owner, change: (memory: readonly BotFact[]) => { memory: BotFact[]; fact: BotFact }) {
    const self = this.caller(hostId, owner).standing ?? fail('Only a standing bot has a memory.');
    const setMemory = this.ports.setMemory ?? fail('Memory cannot be changed on this Relay.');
    const { memory, fact } = change(self.memory ?? []);
    await setMemory(self.groupId, self.viewId, memory);
    await this.inboxes.known(self, { memory });
    return { fact, count: memory.length };
  }
  remember(hostId: string, call: Call<'remember'>) { return this.keepMemory(hostId, call.owner, memory => remembered(memory, call.text, call.replace)); }
  forget(hostId: string, call: Call<'forget'>) { return this.keepMemory(hostId, call.owner, memory => forgotten(memory, call.fact)); }
  /** The bots one chief manages directly (sub-sessions are not bots and do not count). */
  private span(chief: Assistant): number {
    return accountDirectory(this.ports.groups()).filter(item => item.chief === chief.key).length;
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
  /** A standing bot writes one of its own pages; a sub-session never does, and no call names another bot's page to write. */
  async writePage(hostId: string, call: Call<'write_page'>) {
    const self = this.caller(hostId, call.owner), standing = self.task ? fail('A sub-session does not write pages; its bot does.') : self.standing ?? fail('Only a standing bot keeps pages.');
    const { page, created } = await this.pages.write(standing, { title: call.title, contents: call.contents, ...(call.pageId ? { pageId: call.pageId } : {}), ...(call.team ? { team: true as const } : {}) });
    return { pageId: page.pageId, version: page.version, message: `${created ? 'Page created' : 'Page rewritten'}${page.team ? ' as your team page, shown in your conversation and your chief\'s' : ''}.` };
  }
  /** Any standing bot of the account's pages are read: the caller's own by default (a sub-session reads its bot's); with a page id one page, without the list. */
  readPage(hostId: string, call: Call<'read_page'>) {
    const self = this.caller(hostId, call.owner);
    const named = call.bot ? this.named(call.bot, self) : 'self';
    const target = named === 'self' ? (self.task ? this.ownerOf(self)?.standing : self.standing) : named?.standing;
    if (!target) fail(call.bot ? NOT_FOUND : 'Only a standing bot keeps pages.');
    const pages = this.pages.read(target!);
    if (!call.pageId) return { bot: target!.name, pages: pageList(pages) };
    const page = pages.find(item => item.pageId === call.pageId) ?? fail(`${target!.name} has no page ${call.pageId}; list its pages with read_page.`);
    return { bot: target!.name, ...page };
  }
  /**
   * The person marks a standing bot that reports to them as their primary bot, or clears the mark. The Relay's one write keeps at most
   * one; the bots whose role changed are sent their new standing instructions.
   */
  async personSetPrimary(botId: string, primary: boolean) {
    const setPrimary = this.ports.setPrimary ?? fail('The primary bot cannot be set on this Relay.');
    const directory = () => accountDirectory(this.ports.groups()).filter(item => item.key.startsWith('b_'));
    const bot = directory().find(item => item.key === botId) ?? fail('No standing bot of this account has that id.');
    if (primary && bot.chief) fail('Only a bot that reports to you can be primary.');
    const before = directory().filter(item => item.primary).map(item => item.key);
    await setPrimary(botId, primary);
    const after = directory();
    await this.inboxes.ensure(after.filter(item => item.key === botId || before.includes(item.key)));
    return { botId, primary };
  }
  /** The person's own routines of a standing bot: the same operations a bot has, by the person, and Test. */
  async personRoutine(action: Extract<ChainAction, { action: 'routine_set' | 'routine_pause' | 'routine_delete' | 'routine_test' | 'routine_rotate_hook' }>) {
    const bot = accountDirectory(this.ports.groups()).find(item => item.key === action.botId && item.key.startsWith('b_')) ?? fail('No standing bot of this account has that id.');
    if (action.action === 'routine_pause') return this.work.pause(bot, action.name, action.paused);
    if (action.action === 'routine_delete') return this.work.delete(bot, action.name);
    if (action.action === 'routine_test') return this.work.test(bot, action.name);
    if (action.action === 'routine_rotate_hook') return this.work.rotateHook(bot, action.name);
    // The model is one the bot's provider offers, as for the bot's own tool; a Host that cannot list them leaves the choice standing.
    if (action.model !== undefined) {
      const offered = await this.ports.models?.(bot.hostId, bot.providerId, bot.nativeSessionId).catch(() => undefined);
      if (offered?.length && !offered.includes(action.model)) fail(`"${action.model}" is not a model this provider offers. Choose one of: ${offered.join(', ')}.`);
    }
    const { botId: _bot, action: _action, ...spec } = action;
    return this.work.setRoutine(bot, spec as RoutineSpec, 'person');
  }
  routines(botKey: string) { return this.work.list(botKey); }
  /** The person moves a standing bot to a chief, or to themselves (null). */
  async personSetChief(botId: string, chief: string | null) {
    const directory = accountDirectory(this.ports.groups());
    const bot = directory.find(item => item.key === botId && item.key.startsWith('b_')) ?? fail('No standing bot of this account has that id.');
    const to = chief === null ? undefined : directory.find(item => item.key === chief && item.key.startsWith('b_')) ?? fail('No standing bot of this account has that id.');
    return this.moveChief(bot, to);
  }
  /** A standing bot keeps its routines by name (routines design 6): set, listed, paused and deleted by the bot itself. */
  private routineOwner(hostId: string, owner: { providerId: string; nativeSessionId: string }) { return this.main(hostId, owner).standing ?? fail('Only a standing bot keeps routines.'); }
  async setRoutine(hostId: string, call: Call<'set_routine'>, unattended: boolean) {
    const { name, schedule, prompt, model, maxRunsPerDay, untilMinutes } = call;
    return this.work.setRoutine(this.routineOwner(hostId, call.owner), { name, schedule, ...(prompt !== undefined ? { prompt } : {}), ...(model !== undefined ? { model } : {}),
      ...(maxRunsPerDay !== undefined ? { maxRunsPerDay } : {}), ...(untilMinutes !== undefined ? { untilMinutes } : {}) }, 'bot', unattended);
  }
  async listRoutines(hostId: string, call: Call<'list_routines'>) { return { routines: this.work.list(this.routineOwner(hostId, call.owner).key) }; }
  async pauseRoutine(hostId: string, call: Call<'pause_routine'>) { return this.work.pause(this.routineOwner(hostId, call.owner), call.name, call.paused); }
  async deleteRoutine(hostId: string, call: Call<'delete_routine'>) { return this.work.delete(this.routineOwner(hostId, call.owner), call.name); }
  /** The item of the caller's own board a bot is handed work with. */
  private ownItem(self: Bot, key: number): BoardItem {
    const standing = self.standing ?? fail('Only a standing bot keeps a board.');
    return this.board.read(standing)?.items.find(entry => entry.key === key) ?? fail(`No item ${key} on your board; read it with board.`);
  }
  /** The standing bot whose board this is. */
  private boardOwner(key: string): Assistant { return accountDirectory(this.ports.groups()).find(item => item.key === key) ?? fail('The board belongs to a bot that is gone.'); }
  /** Reads a board (bots design 6.1): one's own, or that of a standing bot one is chief of, which is read only; an item handed to the caller on another board. A sub-session reads its bot's board. */
  readBoard(hostId: string, call: Call<'board'>) {
    const self = this.caller(hostId, call.owner);
    let target: Assistant, name = self.name;
    if (self.task) {
      const bot = this.ownerOf(self)?.standing ?? fail('This sub-session\'s bot is gone.');
      target = bot; name = bot.name;
    } else if (call.bot) {
      const named = this.named(call.bot, self);
      if (named === 'self') { target = self.standing ?? fail('Only a standing bot has a board.'); }
      else {
        const owner = typeof named === 'object' ? named.standing : undefined;
        // An assignee also reads the one item that was handed to it, on whichever standing bot's board it sits.
        const handed = owner && call.item !== undefined ? this.board.read(owner)?.items.find(entry => entry.key === call.item && entry.assignee === self.key) : undefined;
        if (owner && handed) return { bot: owner.name, item: handed, readOnly: true };
        if (!owner || owner.chief !== self.key) fail('You read the board of your own standing staff, and the items handed to you, only.');
        target = owner!; name = owner!.name;
      }
    } else target = self.standing ?? fail('Only a standing bot has a board.');
    if (call.workLog) {
      if (target.key !== self.key) fail('You read your own work log only.');
      return { bot: name, workLog: this.inboxes.log(target).map(entry => ({ ...entry, line: workLogLine(entry) })) };
    }
    const board = this.board.read(target), items = board?.items ?? [];
    const readOnly = !!call.bot && target.key !== self.key && !self.task;
    if (call.item !== undefined) return { bot: name, item: items.find(entry => entry.key === call.item) ?? fail(`No item ${call.item} on that board.`), ...(readOnly ? { readOnly } : {}) };
    const ordered = [...items.filter(entry => boardItemOpen(entry.status)), ...items.filter(entry => !boardItemOpen(entry.status))];
    return { bot: name, ...(board?.plan ? { plan: board.plan } : {}), items: ordered.map(entry => ({ ...entry, ...(entry.brief ? { brief: clip(entry.brief, 120) } : {}) })), ...(readOnly ? { readOnly } : {}) };
  }
  /** Writes the caller's own board, or, for a sub-session, the items it owns on its bot's board; the owners of the items a write changes are told. */
  async updateBoard(hostId: string, call: Call<'update_board'>) {
    const self = this.caller(hostId, call.owner);
    const edits = (call.items ?? []).map((edit): ItemEdit => ({ ...edit, ...(edit.assignee !== undefined ? { assignee: this.assignee(hostId, call.owner, edit.assignee, self) } : {}) }));
    let written;
    if (self.task) {
      if (call.plan) fail('A sub-session does not write the plan note.');
      written = await this.board.write(this.ownerOf(self)?.standing ?? fail('This sub-session\'s bot is gone.'), edits, undefined, self.key, self.key);
    } else written = await this.board.write(self.standing ?? fail('Only a standing bot keeps a board.'), edits, call.plan, self.key);
    await this.notify(written.notices.filter(notice => notice.to !== self.key));
    return { items: written.items, ...(written.plan ? { plan: written.plan } : {}) };
  }
  /**
   * The person writes a standing bot's board as the person: the same write as the bot's own, so a stale edit says what it overwrote and
   * every bot an edited item is assigned to is told once, from the record. The person assigns items to the bot itself, its standing
   * staff or its sub-sessions.
   */
  async personUpdateBoard(botId: string, items: readonly BoardItemEdit[] | undefined, plan: BoardPlanEdit | undefined) {
    const bot = accountDirectory(this.ports.groups()).find(item => item.key === botId && botId.startsWith('b_')) ?? fail('No standing bot of this account has that id.');
    const edits = (items ?? []).map((edit): ItemEdit => ({ ...edit, ...(edit.assignee !== undefined ? { assignee: this.staffAssignee(bot, edit.assignee) } : {}) }));
    const written = await this.board.write(bot, edits, plan, 'person');
    await this.notify(written.notices);
    return { items: written.items, ...(written.plan ? { plan: written.plan } : {}) };
  }
  /** An assignee the person names for an item of this bot's board: the bot (self), one of its standing staff or one of its sub-sessions, by id. */
  private staffAssignee(owner: Assistant, id: string): string {
    if (id === 'self' || id === owner.key) return 'self';
    const sub = this.staff(owner.hostId, { providerId: owner.providerId, nativeSessionId: owner.nativeSessionId }).find(team => subSessionId(team.id) === id && team.task!.state !== 'ended');
    if (sub) return id;
    const bot = this.byKey(id);
    return bot?.standing && bot.standing.chief === owner.key ? bot.key : fail('An item is assigned to the bot itself, its standing staff or its sub-sessions.');
  }
  /** Who an item is assigned to: self, a standing bot, or one of the caller's sub-sessions, by name or id. */
  private assignee(hostId: string, owner: Owner, name: string, caller: Bot): string {
    if (fold(name) === 'self') return 'self';
    const sub = this.staff(hostId, owner).find(team => team.task!.state !== 'ended' && (subSessionId(team.id) === name || fold(team.task!.title) === fold(name)));
    if (sub) return subSessionId(sub.id);
    const bot = this.named(name, caller);
    if (bot === 'self') return 'self';
    return bot ? bot.key : fail(NOT_FOUND);
  }
  /** Tells the owners of an item what changed (a bot or a sub-session): written from the record, so one that is gone or ended simply is not told. */
  private async notify(notices: readonly ItemNotice[]): Promise<void> {
    for (const notice of notices) {
      if (notice.to.startsWith('s_')) {
        const team = this.broker.ports.read().find(item => item.task && subSessionId(item.id) === notice.to);
        if (team) await this.tasks.notice(team.id, notice.key, notice.text).catch(() => undefined);
        continue;
      }
      const to = this.byKey(notice.to);
      if (to?.standing) await this.messages.notice(to.standing, notice.key, notice.text).catch(() => undefined);
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
    const from = this.caller(hostId, call.owner);
    if (from.task) return { outcome: 'forbidden', reason: 'A sub-session is not a bot and messages no one; its result goes to its bot when its turn ends.' };
    if (from.answer) return { outcome: 'forbidden', reason: 'An answer session answers with its final text; it does not message bots.' };
    // A room the sender is a member of: its turn's answer, a pass, or the room's result.
    const room = this.rooms.memberRoom(hostId, call.owner, call.to);
    if (room) {
      if (call.attachments) fail('A room message cannot carry files.');
      await this.rooms.speak(hostId, call.pass ? { action: 'room_pass', owner: call.owner, roomId: room.id }
        : { action: 'room_say', owner: call.owner, roomId: room.id, text: call.text, ...(call.status === 'done' ? { done: true } : {}) });
      return { outcome: 'delivered' };
    }
    const to = this.named(call.to, from);
    if (to === 'self') return { outcome: 'forbidden', reason: 'You cannot message yourself.' };
    if (!to) return { outcome: 'unreachable', reason: NOT_FOUND };
    // The files the message carries are listed after the sender's words, written from their records.
    const files: BotAttachment[] = call.attachments ? await Promise.all(call.attachments.map(id => this.files().metadata(id))) : [];
    const text = files.length ? `${call.text}\n${attachmentLines(files)}` : call.text;
    // A message with a status to the bot whose board holds an item assigned to the sender is a report on that item; any other message
    // naming an item only tags the exchange with it: an item is assigned by create_bot with the item or by a board write, never by a message.
    const held = call.status !== undefined && call.status !== 'ack' && to.standing ? heldItem(this.board.read(to.standing), from.key, call.item) : undefined;
    if (call.item !== undefined && !held && from.standing) {
      // The item its receiver's board holds for the sender is the one it names; otherwise it names one of its own board.
      const item = (to.standing ? heldItem(this.board.read(to.standing), from.key, call.item) : undefined) ?? this.board.read(from.standing)?.items.find(entry => entry.key === call.item);
      if (!item) return { outcome: 'forbidden', reason: `No item ${call.item} on your board; read it with board.` };
      return this.route(hostId, from, to, { ...call, text, tag: itemTagText({ key: item.key, title: item.title, from: from.name }) });
    }
    const result = await this.route(hostId, from, to, { ...call, text, ...(held ? { tag: itemTagText({ key: held.key, title: held.title, from: from.name }) } : {}) });
    // The report is the item's latest, whoever made it; its status follows only when the assignee is the bot created for the item.
    if (held && to.standing && (result.outcome === 'delivered' || result.outcome === 'held')) await this.board.report(to.standing, from.key, held.key, call.status, call.text, false);
    return result;
  }
  /** Sends where the sender and receiver say, and marks the messages a standing sender answered by it (bots design 3.3). */
  private async route(hostId: string, from: Bot, to: Bot, call: SendCall): Promise<BotMessageResult> {
    const result = await this.send(hostId, from, to, call);
    // The turn answered its sender by this message, or this message names the one it answers.
    const answers = [...call.replyTo ? [call.replyTo] : [], ...call.cause?.kind === 'framed' && call.cause.answers ? [call.cause.answers] : []];
    if (from.standing && answers.length && (result.outcome === 'delivered' || result.outcome === 'held')) await this.inboxes.answered(from.standing, answers, to.key);
    return result;
  }
  /** Where a message goes by who sends it to whom, and the outcome. */
  private async send(_hostId: string, from: Bot, to: Bot, call: SendCall): Promise<BotMessageResult> {
    return this.messages.deliver(from.standing ?? { key: from.key, name: from.name }, to.standing!, { operationId: call.operationId, text: call.text, ...(call.replyTo ? { replyTo: call.replyTo } : {}), ...(call.final ? { final: true } : {}), ...(call.tag ? { tag: call.tag } : {}), ...(call.status === 'ack' ? { ack: true as const } : {}) });
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
    return this.route(hostId, from, to, { owner: call.owner, operationId: `reply-${entry.id}`, text: cutReply(call.text, from.name), replyTo: entry.id, final: true, cause: call.cause });
  }
  /**
   * The person wrote into a standing bot's session (bots design 3.5): its chief, when a bot, reads the first 300 characters framed
   * as what they are. Nothing is queued for a bot whose chief is the person, who already sees it.
   */
  async told(hostId: string, call: Call<'bot_told'>): Promise<BotMessageResult> {
    const self = this.caller(hostId, call.owner), bot = self.standing;
    if (self.answer) return { outcome: 'forbidden', reason: 'The person asks an answer session; nobody else needs to hear it.' };
    if (!bot) return { outcome: 'forbidden', reason: 'A sub-session\'s bot hears the person through the sub-session\'s own report.' };
    const chief = bot.chief ? this.byKey(bot.chief) : undefined;
    if (!chief?.standing) return { outcome: 'unreachable', reason: 'The person is its chief, or its chief is gone.' };
    return this.messages.deliver(bot, chief.standing, { operationId: call.cause.messageId, text: call.text, frame: 'person' });
  }
  /** The standing bot an id means. */
  private byKey(key: string): Bot | undefined {
    const standing = accountDirectory(this.ports.groups()).find(item => item.key === key && key.startsWith('b_'));
    return standing ? { key: standing.key, name: standing.name, standing } : undefined;
  }
  /** The standing bots of the account the caller may message, each with its name, label and mission; a sub-session is never among them. */
  list(hostId: string, call: Call<'list_bots'>) {
    const self = this.caller(hostId, call.owner);
    const standing = accountDirectory(this.ports.groups()).filter(item => item.key.startsWith('b_') && item.key !== self.key && !item.hidden)
      .map((item): BotListing => ({ id: item.key, name: item.name, ...(item.label ? { label: item.label } : {}), ...(item.mission ? { mission: item.mission } : {}), ...(item.primary ? { primary: true as const } : {}) }));
    // A standing bot also reads where its open board items stand here.
    const open = (self.standing && this.board.read(self.standing)?.items.filter(entry => boardItemOpen(entry.status)).map(summary)) || [];
    return { bots: standing, ...(open.length ? { board: { open: open.length, items: open } } : {}) };
  }
  /** The Hosts of the account with what each reports, for choosing where a bot works. */
  async listHosts(hostId: string, call: Call<'list_hosts'>) {
    this.caller(hostId, call.owner);
    return { hosts: await (this.places ?? fail('Choosing a Host is not available on this Relay.')).list() };
  }
  /** Where a bot's conversation is, for `read_bot`: any standing bot of the account (the person's bots are not secret from each other). A sub-session is no bot: `readSub` reads it. */
  readSession(hostId: string, call: Call<'bot_session'>): { providerId: string; nativeSessionId: string } {
    const self = this.caller(hostId, call.owner);
    // An answer session reads the conversation it was asked from ("asking") and its bot's main session ("main").
    const own = self.answer && fold(call.bot) === 'asking' ? self.answer.ask!.from : self.answer && fold(call.bot) === 'main' ? self.standing : undefined;
    const found = own ?? (() => { const bot = this.named(call.bot, self); return typeof bot === 'object' ? bot.standing : undefined; })();
    if (!found?.nativeSessionId || found.hostId !== hostId) fail(found ? 'That bot runs on another computer; ask it with message instead.' : NOT_FOUND);
    const current = this.broker.ports.resolveSession(found!.hostId, found!.providerId, found!.nativeSessionId!);
    return { providerId: current.providerId, nativeSessionId: current.nativeSessionId };
  }
}
