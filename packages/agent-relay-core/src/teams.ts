import type { HostPlaces } from './host-places.js';
import { compactTeamDeliveries, teamNeedsCompaction, unresolvedTeamDelivery, stripPrivateTeamEvidence, validSavedTeam, withoutHeldAcks, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
export { teamMessageBudgetBytes } from './team-delivery.js';
import type { AttachmentStore } from './attachments.js';
import { accountDirectory, AssistantMessages, type AssistantPorts } from './assistants.js';
import { roomAction, Rooms } from './rooms.js';
import { BotInboxes } from './inboxes.js';
import { BotCalls } from './bot-calls.js';
import { BotAsks } from './bot-asks.js';
import { BotRoutines } from './routines.js';
import { Unattended, memoryUnattended, type UnattendedStore } from './unattended.js';
import { BotPages } from './bot-pages.js';
import { BotBoard } from './bot-board.js';
import { BotChains, editChainId, memoryChains, type ChainStore } from './chains.js';
import { chainScope, inChain, seenBefore, stampChain, subSessionId } from './chain-scope.js';
import { actOnBot, stopInTeams } from './audit.js';
import { TaskGroups, taskAction, taskPresence, taskSettled, type TaskPorts } from './tasks.js';
import { estimateCost, nativeSessionRefKey, type Routine, type TeamAskRequest, type BotMessageResult, type NativeSessionRef, isTeamMember, type Team, type TeamAction, type TeamCreate, type TeamHostCall, type TeamMember, type TeamMessage, type TeamSeat, type TurnCause, type BotChain, type ChainAction, type ChainView } from '@orchardworks/agent-remote-protocol';

export interface TeamBrokerPorts {
  /** Timers of the Relay, for what must happen on time: a room's deadline and a member's turn. */
  scheduler?: { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(timer: unknown): void };
  resolveSession(hostId: string, providerId: string, anchorNativeId: string): NativeSessionRef;
  assertRecipient?(target: NativeSessionRef): void;
  /** generic: the replacement is a generic succession, which may also change the recipient's provider. */
  assertRecipientSupport?(hostId: string, generic?: boolean): void;
  read(): SavedTeam[];
  change<T>(update: (teams: SavedTeam[]) => T): Promise<T>;
  createSeat(hostId: string, seat: TeamSeat): Promise<TeamMember>;
  assertHost(hostId: string, providerId: string): void;
  now(): number;
  /** Absent: this Relay has no tasks. */
  tasks?: TaskPorts;
  /** The account's assistants, which message one another on links. */
  assistants?: AssistantPorts;
  /** Where the account's chains are kept; in memory when absent. */
  chains?: ChainStore;
  /** Where the account's unattended settings, usage and provider limits are kept; in memory when absent. */
  unattended?: UnattendedStore;
  /** Where the files bots attach to messages are kept (bots design 3.4); absent, this Relay takes no attachments. */
  attachments?: AttachmentStore;
  /** Where bots can work: the account's Hosts and their folders, read from their Controllers when asked. */
  places?: HostPlaces;
  /** A chain passed one of the person's thresholds: remind the person that this session, the chain's first bot, needs them, once per identity. */
  alertChain?(session: { hostId: string; providerId: string; nativeSessionId: string }, identity: string): void;
}
type StoredRecipientAnchor = Pick<TeamMember, 'hostId' | 'providerId' | 'nativeSessionId'>;
const fail = (message: string): never => { throw new Error(message); };

const unavailableTasks = 'Tasks are unavailable on this Relay.';
const unavailableAssistants = 'Assistant messages are unavailable on this Relay.';
const tasksUpgrade = 'Update the Controller to use tasks.';
const find = (teams: SavedTeam[], id: string) => teams.find(team => team.id === id) ?? fail('Team not found.');
const member = (team: Team, id: string) => team.members.find(item => item.id === id) ?? fail('Team member not found.');
const active = (team: Team) => { if (team.status !== 'active') fail('Team is not active.'); };
function touch(team: Team, now: number) { team.revision++; team.updatedAt = now; }
/** Queued input that never ran can still be reported undelivered when its recipient is stopped. */
const withdrawable = (message: TeamMessage, outcome: string) => message.status === 'accepted' && message.acceptance === 'queued' && outcome === 'rejected';
/** Membership authority and durable mailboxes; provider execution stays on Controllers. */
export class TeamBroker {
  private creating = new Map<string, Promise<Team>>();
  private readonly tasks?: TaskGroups;
  private readonly assistants?: AssistantMessages;
  private readonly rooms?: Rooms;
  private readonly inboxes?: BotInboxes;
  private readonly bots?: BotCalls;
  private readonly work?: BotRoutines;
  private readonly asks?: BotAsks;
  readonly chains: BotChains;
  readonly unattended: Unattended;
  constructor(private readonly ports: TeamBrokerPorts) {
    const key = (session: { hostId: string; providerId: string; nativeSessionId: string }) => { try { return nativeSessionRefKey(ports.resolveSession(session.hostId, session.providerId, session.nativeSessionId)); } catch { return undefined; } };
    this.unattended = new Unattended(ports.unattended ?? memoryUnattended(), () => ports.now());
    this.chains = new BotChains(ports.chains ?? memoryChains(), () => ports.now(), (a, b) => { const left = key(a); return left !== undefined && left === key(b); },
      (chain, passed) => {
        // The reminder names the bot that started the chain, or the latest of its bots still there when that one is gone.
        const session = [chain.bot, ...[...chain.bots].reverse()].map(bot => this.botSession(bot)).find(Boolean);
        if (session) for (const item of passed) ports.alertChain?.(session, `chain:${chain.id}:${item}`); });
    if (ports.tasks) this.tasks = new TaskGroups({ ports, change: update => this.change(update), provision: (teamId, memberId) => this.provision(teamId, memberId) }, ports.tasks);
    if (ports.assistants) {
      const lent = { ports, change: <T>(update: (teams: SavedTeam[]) => T) => this.change(update), provision: (teamId: string, memberId: string) => this.provision(teamId, memberId) };
      this.inboxes = new BotInboxes(lent, ports.assistants); this.assistants = new AssistantMessages(lent, ports.assistants, this.inboxes); this.rooms = new Rooms(lent, ports.assistants);
      this.work = new BotRoutines(lent, this.inboxes, this.chains, { zone: () => this.unattended.zone(),
        refuse: (inbox, routine, now) => this.unattended.refuse(inbox.inbox!.botId, `${inbox.members[0]!.hostId}/${inbox.members[0]!.providerId}`, routine, now),
        started: bot => this.unattended.countRun(bot),
        startSub: async start => { await (this.tasks ?? fail(unavailableTasks)).create(start.hostId, { owner: { providerId: start.providerId, nativeSessionId: start.nativeSessionId, title: start.title }, operationId: start.operationId,
          name: start.name.slice(0, 120), prompt: start.prompt, model: start.model }); } });
      this.asks = new BotAsks(lent, ports.assistants, this.chains, this.inboxes);
      if (this.tasks) this.bots = new BotCalls(lent, ports.assistants, this.tasks, this.assistants, this.inboxes, this.rooms, this.work, new BotBoard(lent, this.inboxes, this.work), this.asks, new BotPages(lent, this.inboxes), ports.places);
      this.rooms.arm(); this.work.arm(); this.asks.arm();
    }
  }
  private async change<T>(update: (teams: SavedTeam[]) => T): Promise<T> {
    return this.ports.change(teams => {
      // teams is a draft: compaction reads the plain Teams and drafts only those it changes.
      const compact = () => plain(teams).forEach((team, index) => {
        const now = this.ports.now();
        if (teamNeedsCompaction(team, now)) compactTeamDeliveries(teams[index]!, now);
      });
      compact();
      const seen = seenBefore(plain(teams));
      const result = update(teams);
      stampChain(seen, teams);
      compact();
      return result;
    });
  }
  private project(source: SavedTeam): Team {
    const saved = plain(source);
    const team: Team = structuredClone(stripPrivateTeamEvidence(saved));
    if (team.task) team.task.subSessionId = subSessionId(team.id);
    const unresolved = (saved.deliveryReceipts ?? []).flatMap(receipt => {
      if (receipt.status !== 'accepted' || receipt.acceptance !== undefined) return [];
      const { fingerprint: _hash, settledAt: _time, acceptance: _disposition, ...evidence } = receipt;
      return [{ ...evidence, status: receipt.status }];
    });
    if (unresolved.length) team.unresolvedReceipts = structuredClone(unresolved);
    for (const [index, anchor] of saved.members.entries()) if (anchor.nativeSessionId) {
      const recipient = team.members[index]!;
      try { const current = this.resolveRecipientFromAnchor(anchor); recipient.providerId = current.providerId; recipient.nativeSessionId = current.nativeSessionId; }
      catch { delete recipient.nativeSessionId; }
    }
    return team;
  }
  /** The session that holds the member's role now, which a handoff may have moved to another provider. */
  private resolveRecipientFromAnchor(anchor: StoredRecipientAnchor): NativeSessionRef {
    if (!anchor.nativeSessionId) fail('Team recipient is unavailable.');
    return this.ports.resolveSession(anchor.hostId, anchor.providerId, anchor.nativeSessionId!);
  }
  hasUnsettledRecipient(target: NativeSessionRef): boolean {
    return this.ports.read().some(team => [...team.messages, ...(team.deliveryReceipts ?? [])].some(message => {
      if (!unresolvedTeamDelivery(message)) return false;
      if (message.resolvedTarget) return nativeSessionRefKey(message.resolvedTarget) === nativeSessionRefKey(target);
      const seat = member(team, message.to);
      try {
        const actual = this.ports.resolveSession(seat.hostId, target.providerId, target.nativeSessionId);
        if (actual.controllerId !== target.controllerId) return false;
        const anchor = this.ports.resolveSession(seat.hostId, seat.providerId, seat.nativeSessionId!);
        return nativeSessionRefKey(anchor) === nativeSessionRefKey(actual);
      } catch { return true; }
    }));
  }
  readForClient(teamId: string): Team { return this.project(find(this.ports.read(), teamId)); }
  assertReplacementSupported(target: NativeSessionRef, hostId: string, generic = false): void {
    for (const team of this.ports.read()) for (const seat of team.members) {
      if (seat.hostId === hostId && seat.creation === 'ready' && nativeSessionRefKey(this.resolveRecipientFromAnchor(seat)) === nativeSessionRefKey(target)) this.ports.assertRecipientSupport?.(seat.hostId, generic);
    }
  }
  list(): Team[] { return this.ports.read().map(saved => {
    const team = structuredClone(saved); compactTeamDeliveries(team, this.ports.now()); return this.project(team);
  }); }
  async action(input: TeamAction): Promise<Team> {
    if (input.action === 'room_post' || input.action === 'close_room') {
      if (!this.rooms) fail(unavailableAssistants);
      const changed = await this.change(teams => { const team = find(teams, input.teamId); roomAction(team, input as Parameters<typeof roomAction>[1], this.ports.now()); return team; });
      this.rooms?.arm();
      return this.project(changed);
    }
    if (input.action === 'stop_sub_session') {
      if (!this.tasks) fail(unavailableTasks);
      return this.project(await this.change(teams => { const team = find(teams, input.teamId); taskAction(team, this.ports.now(), 'person'); return team; }));
    }
    return fail('This action is not available.');
  }
  /** The routines of a standing bot as they stand now. */
  routines(botKey: string): Routine[] { return this.work?.list(botKey) ?? []; }
  /** The person runs a routine of a bot now. */
  routineTest(botKey: string, name: string) { return (this.bots ?? fail(unavailableAssistants)).personRoutine({ action: 'routine_test', botId: botKey, name }); }
  /** The account's chains, newest first, and the names of the bots they name. */
  chainView(): ChainView {
    const chains = this.chains.list(), wanted = new Set(chains.flatMap(chain => chain.bots)), names: Record<string, string> = {};
    for (const bot of this.ports.assistants ? accountDirectory(this.ports.assistants.groups()) : []) if (wanted.has(bot.key)) names[bot.key] = bot.name;
    const routines: Record<string, Routine[]> = {};
    for (const team of this.ports.read()) if (team.inbox && team.status === 'active' && team.inbox.routines?.length) routines[team.inbox.botId] = this.work?.list(team.inbox.botId) ?? [];
    void this.unattended.touch()?.catch(() => undefined);
    return { chains, names, unattended: this.unattended.view(), thresholds: this.chains.thresholds(), paused: this.ports.read().filter(team => team.inbox?.paused).map(team => team.inbox!.botId), routines };
  }
  /** The person mentions a bot from a conversation: the bot answers in its answer session for that conversation (bots plan 8b). */
  async ask(input: TeamAskRequest): Promise<Team> { return this.project(await (this.asks ?? fail(unavailableAssistants)).ask(input)); }
  /** The person starts a sub-session beside a conversation (`/side`, bots design 9): its first work is the text; its result shows beside the conversation and reaches no bot. */
  async startBot(input: TeamCreate): Promise<SavedTeam> {
    const tasks = this.tasks ?? fail(unavailableTasks), bot = input.bot ?? fail('A sub-session needs a name and its first work.');
    const created = await tasks.create(input.source.hostId, { owner: { providerId: input.source.providerId, nativeSessionId: input.source.nativeSessionId,
      ...(input.source.title ? { title: input.source.title } : {}) }, operationId: input.operationId, name: bot.name.slice(0, 120), prompt: bot.mission, ...(input.fork ? { fork: input.fork } : {}) }, { startedBy: 'person' });
    return this.ports.read().find(team => team.id === created.taskId) ?? fail('The sub-session could not be started.');
  }
  /** The person's decision from the audit: stop a chain or a bot's part of it, pause or resume a standing bot, retire a temporary one. */
  async chainAction(action: ChainAction): Promise<unknown> {
    if (action.action === 'stop' || action.action === 'stop_bot') {
      if (!this.chains.list().some(chain => chain.id === action.chainId)) fail('No chain of this account has that id.');
      const botId = action.action === 'stop_bot' ? action.botId : undefined;
      await this.chains.stop(action.chainId, botId);
      const result = await this.change(teams => stopInTeams(teams, action.chainId, botId, this.ports.now()));
      return { chainId: action.chainId, ...(botId ? { botId } : {}), ...result };
    }
    if (action.action === 'revoke_approval') { await this.chains.revoke(action.chainId, action.cwd); return { chainId: action.chainId, cwd: action.cwd }; }
    if (action.action === 'set_thresholds') { await this.chains.setThresholds(action.thresholds); return { thresholds: action.thresholds }; }
    if (action.action === 'update_board') {
      // What the bots are told of the person's edit is one chain of its own, caused by the person: not the timer chain the bot ran in last.
      const bots = this.bots ?? fail(unavailableAssistants), scope = chainScope(editChainId(action.botId, this.ports.now()));
      try { return await inChain(scope, () => bots.personUpdateBoard(action.botId, action.items, action.plan)); }
      finally { await this.chains.record(scope, { cause: 'person', bot: action.botId }).catch(() => undefined); }
    }
    if (action.action === 'routine_set' || action.action === 'routine_pause' || action.action === 'routine_delete' || action.action === 'routine_test') return (this.bots ?? fail(unavailableAssistants)).personRoutine(action);
    if (action.action === 'set_unattended') return this.unattended.patch(action.patch);
    if (action.action === 'set_primary') return (this.bots ?? fail(unavailableAssistants)).personSetPrimary(action.botId, action.primary);
    if (action.action === 'set_chief') return (this.bots ?? fail(unavailableAssistants)).personSetChief(action.botId, action.chief);
    if (action.action !== 'pause_bot' && action.action !== 'resume_bot') fail('This action is not available.');
    return this.change(teams => actOnBot(teams, action, this.ports.now()));
  }
  /** Where a bot's main session is: a standing bot's view. */
  private botSession(botId: string): { hostId: string; providerId: string; nativeSessionId: string } | undefined {
    const standing = this.ports.assistants ? accountDirectory(this.ports.assistants.groups()).find(bot => bot.key === botId) : undefined;
    if (standing) return { hostId: standing.hostId, providerId: standing.providerId, nativeSessionId: standing.nativeSessionId };
    return undefined;
  }
  /** Runs a bot's call in the chain of the turn it is made in, then adds what it did to the chain (bots design 7). */
  private async chained<T>(hostId: string, owner: { providerId: string; nativeSessionId: string }, cause: TurnCause | undefined, run: () => Promise<T>, stopped?: (reason: string) => T): Promise<T> {
    const bot = this.bots ? (() => { try { return this.bots!.callerKey(hostId, owner); } catch { return undefined; } })() : undefined;
    if (!bot) return run();
    const found = this.chains.find(this.ports.read(), { hostId, ...owner }, cause), scope = chainScope(found.id);
    if (this.chains.stopped(found.id, bot)) {
      const reason = 'The person stopped this work. Do not go on with it; when the person writes to you, tell them where it stands.';
      return stopped ? stopped(reason) : fail(reason);
    }
    try { return await inChain(scope, run); }
    finally { await this.chains.record(scope, { cause: found.cause, bot }).catch(() => undefined); }
  }
  async hostCall(hostId: string, call: TeamHostCall, assertCurrent: () => void = () => {}): Promise<unknown> {
    assertCurrent();
    // A Controller that does not run tasks never sees them.
    const visible = (team: SavedTeam) => (!team.task || this.ports.tasks?.capable(hostId) === true)
      && (!team.link && !team.room && !team.inbox && !team.ask || this.ports.assistants?.capable(hostId) === true);
    if (call.action === 'poll') await this.bots?.endRetired().catch(() => undefined);
    if (call.action === 'poll') return this.ports.read().filter(team => team.status !== 'archived' && visible(team) && team.members.some(item => item.hostId === hostId && item.creation === 'ready'))
      // A paused bot's messages wait on the Relay until the person resumes it.
      .map(team => this.project(team.inbox?.paused ? { ...team, messages: team.messages.filter(message => message.status !== 'queued') } : withoutHeldAcks(team)));
    // The Host's sessions that are bots: they get the bots' tools and standing instructions. Bots another bot created join their group here.
    if (call.action === 'bot_enablement') {
      if (!this.assistants) return { bots: [] };
      await this.inboxes!.place(hostId);
      await this.inboxes!.ensure(this.assistants.hostBots(hostId));
      return { bots: this.assistants.bots(hostId) };
    }
    if (call.action === 'create_sub_session') { const bots = this.bots ?? fail(unavailableAssistants); return this.chained(hostId, call.owner, call.cause, () => bots.createSub(hostId, call)); }
    if (call.action === 'send_to_sub_session') { const bots = this.bots ?? fail(unavailableAssistants); return this.chained(hostId, call.owner, call.cause, () => bots.sendSub(hostId, call)); }
    if (call.action === 'get_sub_session_status') return (this.bots ?? fail(unavailableAssistants)).subStatus(hostId, call);
    if (call.action === 'stop_sub_session') return (this.bots ?? fail(unavailableAssistants)).stopSub(hostId, call);
    if (call.action === 'sub_update') return (this.bots ?? fail(unavailableAssistants)).subUpdate(hostId, call);
    if (call.action === 'sub_turn_end') {
      assertCurrent();
      const result = await (this.bots ?? fail(unavailableAssistants)).subTurnEnd(hostId, call);
      // A routine's run in a sub-session of its own ends with the sub-session's turn; its team is named by the run's chain.
      const team = this.ports.read().find(item => item.id === call.teamId);
      if (team?.operationId.startsWith('routine:')) {
        const chainId = team.operationId.slice('routine:'.length), bot = this.chains.list().find(chain => chain.id === chainId)?.bot, estimate = estimateCost(call.usage, call.tokens ?? 0, this.unattended.settings());
        if (bot) {
          await this.chains.record(chainScope(chainId), { cause: 'routine', bot }, { tokens: call.tokens ?? 0, estimatedUsd: estimate.usd }).catch(() => undefined);
          await this.unattended.record(bot, estimate, call.usage?.model).catch(() => undefined);
        }
        await this.work?.turnEnded(chainId, { tokens: estimate.tokens || call.tokens || 0, usd: estimate.usd, flags: estimate.flags }, call.outcome);
        // The sub-session did its one piece of work: it ends, so a routine that runs often does not fill the bot's sub-sessions.
        await this.change(teams => { const own = find(teams, call.teamId); if (own.task?.state !== 'ended') taskAction(own, this.ports.now(), 'person'); }).catch(() => undefined);
      }
      return result;
    }
    if (call.action === 'sub_told') { assertCurrent(); return (this.tasks ?? fail(unavailableTasks)).tell(hostId, call); }
    if (call.action === 'create_bot') { const bots = this.bots ?? fail(unavailableAssistants); return this.chained(hostId, call.owner, call.cause, () => bots.create(hostId, call)); }
    if (call.action === 'bot_message') { const bots = this.bots ?? fail(unavailableAssistants); return this.chained<BotMessageResult>(hostId, call.owner, call.cause, () => bots.message(hostId, call), reason => ({ outcome: 'forbidden', reason })); }
    if (call.action === 'attachment_begin' || call.action === 'attachment_chunk' || call.action === 'attachment_finish' || call.action === 'attachment_read') return (this.bots ?? fail(unavailableAssistants)).attachment(hostId, call);
    if (call.action === 'bot_reply') { const bots = this.bots ?? fail(unavailableAssistants); return this.chained<BotMessageResult>(hostId, call.owner, call.cause, () => bots.reply(hostId, call), reason => ({ outcome: 'forbidden', reason })); }
    if (call.action === 'bot_answer') return (this.asks ?? fail(unavailableAssistants)).answer(hostId, call);
    if (call.action === 'bot_told') { const bots = this.bots ?? fail(unavailableAssistants); return this.chained<BotMessageResult>(hostId, call.owner, call.cause, () => bots.told(hostId, call), reason => ({ outcome: 'forbidden', reason })); }
    if (call.action === 'chain_turn') { const bots = this.bots ?? fail(unavailableAssistants), found = this.chains.find(this.ports.read(), { hostId, ...call.owner }, call.cause), bot = bots.callerKey(hostId, call.owner);
      const estimate = estimateCost(call.usage, call.tokens, this.unattended.settings());
      await this.chains.record(chainScope(found.id), { cause: found.cause, bot }, { tokens: call.tokens, estimatedUsd: estimate.usd, ...(call.costUsd !== undefined ? { costUsd: call.costUsd } : {}) });
      // What a chain began without the person costs the account's unattended budget; a cap reached tells the person once.
      if (this.chains.unattended(found.id)) {
        await this.unattended.record(bot, estimate, call.usage?.model);
        await this.work?.turnEnded(found.id, { tokens: estimate.tokens || call.tokens, usd: estimate.usd, flags: estimate.flags });
        const session = this.botSession(bot), day = this.unattended.view().day;
        if (session) for (const item of this.unattended.tripped()) this.ports.alertChain?.(session, `budget:${item.scope}:${item.period}:${item.period === 'day' ? day : day.slice(0, 7)}`);
      }
      return { chain: found.id }; }
    if (call.action === 'provider_limit') {
      const bots = this.bots ?? fail(unavailableAssistants), bot = bots.callerKey(hostId, call.owner), provider = `${hostId}/${call.owner.providerId}`;
      await this.unattended.setLimit(provider, call.resetsAt);
      const session = this.botSession(bot);
      if (session) this.ports.alertChain?.(session, `limit:${provider}:${call.resetsAt ?? Math.floor(this.ports.now() / 3_600_000)}`);
      return { provider };
    }
    if (call.action === 'chain_approval') { const bots = this.bots ?? fail(unavailableAssistants), found = this.chains.find(this.ports.read(), { hostId, ...call.owner }, call.cause), bot = bots.callerKey(hostId, call.owner);
      if (!call.grant) return { allowed: await this.chains.covers(found.id, bot, call.cwd) };
      await this.chains.approve(found.id, { cause: found.cause, bot }, call.cwd); return { chain: found.id }; }
    if (call.action === 'set_routine') { const bots = this.bots ?? fail(unavailableAssistants), found = this.chains.find(this.ports.read(), { hostId, ...call.owner }, call.cause); return bots.setRoutine(hostId, call, this.chains.unattended(found.id)); }
    if (call.action === 'list_routines') return (this.bots ?? fail(unavailableAssistants)).listRoutines(hostId, call);
    if (call.action === 'pause_routine') return (this.bots ?? fail(unavailableAssistants)).pauseRoutine(hostId, call);
    if (call.action === 'delete_routine') return (this.bots ?? fail(unavailableAssistants)).deleteRoutine(hostId, call);
    if (call.action === 'board') return (this.bots ?? fail(unavailableAssistants)).readBoard(hostId, call);
    if (call.action === 'update_board') return (this.bots ?? fail(unavailableAssistants)).updateBoard(hostId, call);
    if (call.action === 'write_page') return (this.bots ?? fail(unavailableAssistants)).writePage(hostId, call);
    if (call.action === 'read_page') return (this.bots ?? fail(unavailableAssistants)).readPage(hostId, call);
    if (call.action === 'remember') return (this.bots ?? fail(unavailableAssistants)).remember(hostId, call);
    if (call.action === 'forget') return (this.bots ?? fail(unavailableAssistants)).forget(hostId, call);
    if (call.action === 'set_chief') return (this.bots ?? fail(unavailableAssistants)).setChief(hostId, call);
    if (call.action === 'update_mission') return (this.bots ?? fail(unavailableAssistants)).updateMission(hostId, call);
    if (call.action === 'list_hosts') return (this.bots ?? fail(unavailableAssistants)).listHosts(hostId, call);
    if (call.action === 'list_bots') return (this.bots ?? fail(unavailableAssistants)).list(hostId, call);
    if (call.action === 'bot_session') return (this.bots ?? fail(unavailableAssistants)).readSession(hostId, call);
    if (call.action === 'read_sub_session') return (this.bots ?? fail(unavailableAssistants)).readSub(hostId, call);
    if (call.action === 'open_room') { const rooms = this.rooms ?? fail(unavailableAssistants); return this.chained(hostId, call.owner, call.cause, () => rooms.open(hostId, call)); }
    if (call.action === 'room_say' || call.action === 'room_pass') return (this.rooms ?? fail(unavailableAssistants)).speak(hostId, call);
    if (call.action === 'list_assistants') return (this.assistants ?? fail(unavailableAssistants)).list(hostId, call);
    if (call.action === 'message_assistant') return (this.assistants ?? fail(unavailableAssistants)).message(hostId, call);
    return this.change(teams => {
      assertCurrent();
      const team = find(teams, call.teamId), self = member(team, call.memberId), now = this.ports.now();
      if (self.hostId !== hostId || self.creation !== 'ready') fail('This Host is not the registered Team member.');
      if (!visible(team)) fail(tasksUpgrade);
      if (call.action === 'read') return { ...this.project(team), receipts: team.deliveryReceipts?.map(({ fingerprint: _hash, settledAt: _time, ...receipt }) => receipt) ?? [] };
      if (call.action === 'presence') {
        const before = self.activity;
        if (team.task) { self.activity = call.activity; taskPresence(team, self, before, call.interaction, now); if (before !== call.activity) self.updatedAt = now; return team.status; }
        if (self.activity === call.activity) return team.status; self.activity = call.activity; self.updatedAt = now; return team.status;
      }
      if (call.action === 'settle' || call.action === 'claim') {
        const message = team.messages.find(item => item.id === call.messageId && item.to === self.id);
        if (!message) {
          const receipt = team.deliveryReceipts?.find(item => item.id === call.messageId && item.to === self.id);
          if (!receipt) fail('Message is not addressed to this member.');
          if (call.action === 'claim') return fail('Message is already settled.');
          if (call.resolvedTarget && (!receipt!.resolvedTarget || nativeSessionRefKey(call.resolvedTarget) !== nativeSessionRefKey(receipt!.resolvedTarget))) fail('Team receipt recipient changed.');
          if (receipt!.status !== call.outcome) fail('Message is already settled.');
          const { fingerprint: _hash, settledAt: _time, ...result } = receipt!;
          return result;
        }
        if (call.action === 'claim') {
          active(team); if (message.status !== 'queued') fail('Message is already claimed.');
          if (team.inbox?.paused) fail('The person paused this bot.');
          const target = this.resolveRecipientFromAnchor(self);
          if (call.expectedNativeSessionId === undefined ? target.nativeSessionId !== self.nativeSessionId : call.expectedNativeSessionId !== target.nativeSessionId) fail('Team recipient moved or does not match the claim.');
          this.ports.assertRecipient?.(target);
          message.resolvedTarget = structuredClone(target); message.status = 'dispatching'; self.activity = 'busy';
          // The session now works in this message's chain (bots design 7).
          if (message.chain) self.chain = { id: message.chain, at: now };
        }
        else { if (call.resolvedTarget && (!message.resolvedTarget || nativeSessionRefKey(call.resolvedTarget) !== nativeSessionRefKey(message.resolvedTarget))) fail('Team receipt recipient changed.'); if (message.status !== 'dispatching' && message.status !== 'unknown' && message.status !== call.outcome && !withdrawable(message, call.outcome)) fail('Message is already settled.'); message.status = call.outcome; if (message.acceptance !== 'started' && message.acceptance !== 'handled') message.acceptance = call.acceptance; message.error = call.error; }
        if (call.action === 'settle') taskSettled(team, message, now);
        return message;
      }
      active(team);
      return fail('This Host call is not available.');
    });
  }
  private provision(teamId: string, memberId: string): Promise<Team> {
    const key = `${teamId}:${memberId}`, pending = this.creating.get(key); if (pending) return pending;
    const run = this.provisionOnce(teamId, memberId).finally(() => this.creating.delete(key)); this.creating.set(key, run); return run;
  }
  private async provisionOnce(teamId: string, memberId: string): Promise<Team> {
    const team = find(this.ports.read(), teamId), item = member(team, memberId); active(team);
    if (item.creation === 'ready') return this.project(team);
    let result: TeamMember;
    try {
      result = await this.ports.createSeat(item.hostId, { teamId, source: team.source, member: item,
        ...(team.task ? { task: { title: team.task.title } } : {}), ...(team.link ? { link: { peer: team.members.find(other => other.id !== item.id)!.name } } : {}), ...(team.room ? { room: { name: team.room.name } } : {}), ...(team.ask ? { ask: this.asks!.seat(team) } : {}), ...(team.inbox ? { inbox: { botId: team.inbox.botId, ...(team.inbox.pending ? { mission: team.inbox.pending.mission } : {}) } } : {}) });
      if (!isTeamMember(result) || result.id !== item.id || result.hostId !== item.hostId || result.providerId !== item.providerId || result.role !== item.role || result.creation !== 'ready' || !result.nativeSessionId) fail('Invalid Host member registration.');
    } catch (error) { result = { ...item, creation: 'unknown', error: error instanceof Error ? error.message.slice(0, 2048) : 'Member creation is uncertain.' }; }
    return this.change(teams => {
      const current = find(teams, teamId), slot = member(current, memberId);
      // A main session may hold requester seats in several Teams (its tasks, links, rooms, inbox); any other session holds one Team seat.
      if (result.creation === 'ready' && teams.some(other => other.members.some(candidate => candidate !== slot && candidate.creation === 'ready' && candidate.hostId === result.hostId && candidate.providerId === result.providerId && candidate.nativeSessionId === result.nativeSessionId
        && (candidate.role !== 'requester' || result.role !== 'requester')))) fail('Native session is already bound to a Team member.');
      if (slot.creation !== 'abandoned') Object.assign(slot, result);
      // An archive may have started while native creation was in progress. Never reactivate it.
      if (current.status === 'active') touch(current, this.ports.now());
      if (!validSavedTeam(current)) fail('Invalid Team state.'); return this.project(current);
    });
  }
}
