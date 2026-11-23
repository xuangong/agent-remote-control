import { compactTeamDeliveries, teamNeedsCompaction, unresolvedTeamDelivery, stripPrivateTeamEvidence, validSavedTeam, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
export { teamMessageBudgetBytes } from './team-delivery.js';
import type { TeamResourceStore } from './team-resources.js';
import { accountDirectory, AssistantMessages, type AssistantPorts } from './assistants.js';
import { roomAction, Rooms } from './rooms.js';
import { BotInboxes } from './inboxes.js';
import { BotCalls } from './bot-calls.js';
import { BotWork } from './bot-work.js';
import { BotChains, memoryChains, type ChainStore } from './chains.js';
import { chainScope, inChain, seenBefore, stampChain, temporaryBotId } from './chain-scope.js';
import { actOnBot, stopInTeams } from './audit.js';
import { TaskGroups, taskAction, taskPresence, taskSettled, type TaskPorts } from './tasks.js';
import { createHash } from 'node:crypto';
import { nativeSessionRefKey, type NativeSessionRef, isTeamMember, type Team, type TeamAction, type TeamCreate, type TeamHostCall, type TeamMember, type TeamMessage, type TeamSeat, type TeamResource, type TurnCause, type BotChain, type ChainAction, type ChainView } from '@orchardworks/agent-remote-protocol';

export interface TeamBrokerPorts {
  /** Timers of the Relay, for what must happen on time: a room's deadline and a member's turn. */
  scheduler?: { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(timer: unknown): void };
  resolveSession(hostId: string, providerId: string, anchorNativeId: string): NativeSessionRef;
  assertRecipient?(target: NativeSessionRef): void;
  /** generic: the replacement is a generic succession, which may also change the recipient's provider. */
  assertRecipientSupport?(hostId: string, generic?: boolean): void;
  resources?: TeamResourceStore;
  resourceDraftTtlMs?: number;
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
  /** A chain passed one of the person's thresholds: remind the person that this session, the chain's first bot, needs them, once per identity. */
  alertChain?(session: { hostId: string; providerId: string; nativeSessionId: string }, identity: string): void;
}
const upgradeRequired = 'Update the Controller for exact Team recipients. Reload the browser after updating the Relay to inspect this Team safely.';
type StoredRecipientAnchor = Pick<TeamMember, 'hostId' | 'providerId' | 'nativeSessionId'>;
const withoutRecipient = <T extends { id: string; resolvedTarget?: NativeSessionRef }>(value: T): Omit<T, 'resolvedTarget'> => { const { resolvedTarget: _target, ...legacy } = value; return legacy; };
const fail = (message: string): never => { throw new Error(message); };

const unavailableTasks = 'Tasks are unavailable on this Relay.';
const unavailableAssistants = 'Assistant messages are unavailable on this Relay.';
const tasksUpgrade = 'Update the Controller to use tasks.';
const sameRecipient = (current: NativeSessionRef, anchor: StoredRecipientAnchor) => current.providerId === anchor.providerId && current.nativeSessionId === anchor.nativeSessionId;
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
  private readonly work?: BotWork;
  readonly chains: BotChains;
  constructor(private readonly ports: TeamBrokerPorts) {
    const key = (session: { hostId: string; providerId: string; nativeSessionId: string }) => { try { return nativeSessionRefKey(ports.resolveSession(session.hostId, session.providerId, session.nativeSessionId)); } catch { return undefined; } };
    this.chains = new BotChains(ports.chains ?? memoryChains(), () => ports.now(), (a, b) => { const left = key(a); return left !== undefined && left === key(b); },
      (chain, passed) => { const session = this.botSession(chain.bot); if (session) for (const item of passed) ports.alertChain?.(session, `chain:${chain.id}:${item}`); });
    if (ports.tasks) this.tasks = new TaskGroups({ ports, change: update => this.change(update), provision: (teamId, memberId) => this.provision(teamId, memberId) }, ports.tasks);
    if (ports.assistants) {
      const lent = { ports, change: <T>(update: (teams: SavedTeam[]) => T) => this.change(update), provision: (teamId: string, memberId: string) => this.provision(teamId, memberId) };
      this.inboxes = new BotInboxes(lent, ports.assistants); this.assistants = new AssistantMessages(lent, ports.assistants, this.inboxes); this.rooms = new Rooms(lent, ports.assistants);
      this.work = new BotWork(lent, this.inboxes, this.chains);
      if (this.tasks) this.bots = new BotCalls(lent, ports.assistants, this.tasks, this.assistants, this.inboxes, this.rooms, this.work);
      this.rooms.arm(); this.work.arm();
    }
  }
  private async change<T>(update: (teams: SavedTeam[]) => T): Promise<T> {
    let removed = false;
    const value = await this.ports.change(teams => {
      // teams is a draft: compaction reads the plain Teams and drafts only those it changes.
      const compact = () => plain(teams).forEach((team, index) => {
        const now = this.ports.now();
        if (teamNeedsCompaction(team, now)) compactTeamDeliveries(teams[index]!, now);
      });
      compact();
      const existing = plain(teams).map(team => team.id), seen = seenBefore(plain(teams));
      const result = update(teams);
      stampChain(seen, teams);
      compact();
      const remaining = new Set(plain(teams).map(team => team.id));
      removed = existing.some(id => !remaining.has(id));
      return result;
    });
    if (removed) await this.retainResources();
    return value;
  }
  private project(source: SavedTeam, recipientAware = true): Team {
    const saved = plain(source);
    const team: Team = structuredClone(stripPrivateTeamEvidence(saved));
    const unresolved = (saved.deliveryReceipts ?? []).flatMap(receipt => {
      if (receipt.status !== 'accepted' || receipt.acceptance !== undefined) return [];
      const { fingerprint: _hash, settledAt: _time, acceptance: _disposition, ...evidence } = receipt;
      return [{ ...evidence, status: receipt.status }];
    });
    if (unresolved.length) team.unresolvedReceipts = structuredClone(unresolved);
    if (!recipientAware) {
      if (unresolved.length || saved.members.some(anchor => {
        if (!anchor.nativeSessionId) return anchor.creation === 'ready';
        if (anchor.nativeSessionId.length > 256) return true;
        try { return !sameRecipient(this.resolveRecipientFromAnchor(anchor), anchor); }
        catch { return false; } // Offline seats retain their persisted anchor for read-only display.
      })) fail(upgradeRequired);
      team.messages = team.messages.map(withoutRecipient);
      return team;
    }
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
  readForClient(teamId: string, recipientAware: boolean): Team { return this.project(find(this.ports.read(), teamId), recipientAware); }
  assertReplacementSupported(target: NativeSessionRef, hostId: string, generic = false): void {
    for (const team of this.ports.read()) for (const seat of team.members) {
      if (seat.hostId === hostId && seat.creation === 'ready' && nativeSessionRefKey(this.resolveRecipientFromAnchor(seat)) === nativeSessionRefKey(target)) this.ports.assertRecipientSupport?.(seat.hostId, generic);
    }
  }
  list(recipientAware = true): Team[] { return this.ports.read().map(saved => {
    const team = structuredClone(saved); compactTeamDeliveries(team, this.ports.now()); return this.project(team, recipientAware);
  }); }
  async action(input: TeamAction): Promise<Team> {
    if (input.action === 'room_post' || input.action === 'close_room') {
      if (!this.rooms) fail(unavailableAssistants);
      const changed = await this.change(teams => { const team = find(teams, input.teamId); roomAction(team, input as Parameters<typeof roomAction>[1], this.ports.now()); return team; });
      this.rooms?.arm();
      return this.project(changed);
    }
    if (input.action === 'keep_task') return this.project(await (this.bots ?? fail(unavailableAssistants)).keep(input.teamId));
    if (input.action === 'cancel_task' || input.action === 'mark_task_done') {
      if (!this.tasks) fail(unavailableTasks);
      return this.project(await this.change(teams => { const team = find(teams, input.teamId); taskAction(team, input.action as 'cancel_task' | 'mark_task_done', this.ports.now()); return team; }));
    }
    return fail('This action is not available.');
  }
  /** The account's chains, newest first, and the names of the bots they name: standing bots by their records, temporary ones by their tasks. */
  chainView(): ChainView {
    const chains = this.chains.list(), wanted = new Set(chains.flatMap(chain => chain.bots)), names: Record<string, string> = {}, kinds: ChainView['kinds'] = {};
    for (const bot of this.ports.assistants ? accountDirectory(this.ports.assistants.groups()) : []) if (wanted.has(bot.key)) { names[bot.key] = bot.name; kinds[bot.key] = 'standing'; }
    for (const team of this.ports.read()) if (team.task && wanted.has(temporaryBotId(team.id))) { names[temporaryBotId(team.id)] = team.task.title; kinds[temporaryBotId(team.id)] = 'temporary'; }
    return { chains, names, kinds, thresholds: this.chains.thresholds(), paused: this.ports.read().filter(team => team.inbox?.paused).map(team => team.inbox!.botId) };
  }
  /** The person starts a temporary bot whose chief is a session (`/side`, bots design 9): a task of that session, its mission the brief. */
  async startBot(input: TeamCreate): Promise<SavedTeam> {
    const tasks = this.tasks ?? fail(unavailableTasks), bot = input.bot ?? fail('A bot needs a name and a mission.');
    const created = await tasks.create(input.source.hostId, { action: 'create_task', owner: { providerId: input.source.providerId, nativeSessionId: input.source.nativeSessionId,
      ...(input.source.title ? { title: input.source.title } : {}) }, operationId: input.operationId, title: bot.name, brief: bot.mission });
    return this.ports.read().find(team => team.id === created.taskId) ?? fail('The bot could not be started.');
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
    if (action.action === 'set_thresholds') { await this.chains.setThresholds(action.thresholds); return { thresholds: action.thresholds }; }
    return this.change(teams => actOnBot(teams, action, this.ports.now()));
  }
  /** Where a bot's main session is: a standing bot's view, or a temporary bot's worker. */
  private botSession(botId: string): { hostId: string; providerId: string; nativeSessionId: string } | undefined {
    const standing = this.ports.assistants ? accountDirectory(this.ports.assistants.groups()).find(bot => bot.key === botId) : undefined;
    if (standing) return { hostId: standing.hostId, providerId: standing.providerId, nativeSessionId: standing.nativeSessionId };
    const worker = this.ports.read().find(team => team.task && temporaryBotId(team.id) === botId)?.members[0];
    return worker?.nativeSessionId ? { hostId: worker.hostId, providerId: worker.providerId, nativeSessionId: worker.nativeSessionId } : undefined;
  }
  /** Runs a bot's call in the chain of the turn it is made in, then adds what it did to the chain (bots design 7). */
  private async chained<T>(hostId: string, owner: { providerId: string; nativeSessionId: string }, cause: TurnCause | undefined, run: () => Promise<T>): Promise<T> {
    const bot = this.bots ? (() => { try { return this.bots!.callerKey(hostId, owner); } catch { return undefined; } })() : undefined;
    if (!bot) return run();
    const found = this.chains.find(this.ports.read(), { hostId, ...owner }, cause), scope = chainScope(found.id);
    if (this.chains.stopped(found.id, bot)) fail('The person stopped this work. Do not go on with it; when the person writes to you, tell them where it stands.');
    try { return await inChain(scope, run); }
    finally { await this.chains.record(scope, { cause: found.cause, bot }).catch(() => undefined); }
  }
  async hostCall(hostId: string, call: TeamHostCall, assertCurrent: () => void = () => {}, recipientAware = true): Promise<unknown> {
    assertCurrent();
    if (!recipientAware && (call.action === 'claim' && call.expectedNativeSessionId !== undefined || call.action === 'settle' && call.resolvedTarget)) fail(upgradeRequired);
    // A Controller that does not run tasks never sees them.
    const visible = (team: SavedTeam) => (!team.task || this.ports.tasks?.capable(hostId) === true)
      && (!team.link && !team.room && !team.inbox || this.ports.assistants?.capable(hostId) === true);
    if (call.action === 'poll') return this.ports.read().filter(team => team.status !== 'archived' && visible(team) && team.members.some(item => item.hostId === hostId && item.creation === 'ready'))
      // A paused bot's messages wait on the Relay until the person resumes it.
      .map(team => this.project(team.inbox?.paused ? { ...team, messages: team.messages.filter(message => message.status !== 'queued') } : team, recipientAware));
    const projectDelivery = <T extends { id: string; resolvedTarget?: NativeSessionRef }>(value: T) => recipientAware ? value : withoutRecipient(value);
    // The Host's sessions that are bots: they get the bots' tools and standing instructions. Bots another bot created join their group here.
    if (call.action === 'bot_enablement') {
      if (!this.assistants) return { bots: [] };
      await this.inboxes!.place(hostId);
      await this.inboxes!.ensure(this.assistants.hostBots(hostId));
      return { bots: this.assistants.bots(hostId) };
    }
    if (call.action === 'create_task') {
      const tasks = this.tasks ?? fail(unavailableTasks);
      if (tasks.capable(hostId)) this.assistants?.assertBot(hostId, call.owner);
      return tasks.create(hostId, call);
    }
    if (call.action === 'create_bot') { const bots = this.bots ?? fail(unavailableAssistants); return this.chained(hostId, call.owner, call.cause, () => bots.create(hostId, call)); }
    if (call.action === 'bot_message') { const bots = this.bots ?? fail(unavailableAssistants); return this.chained(hostId, call.owner, call.cause, () => bots.message(hostId, call)); }
    if (call.action === 'chain_turn') { const bots = this.bots ?? fail(unavailableAssistants), found = this.chains.find(this.ports.read(), { hostId, ...call.owner }, call.cause);
      await this.chains.record(chainScope(found.id), { cause: found.cause, bot: bots.callerKey(hostId, call.owner) }, { tokens: call.tokens, ...(call.costUsd !== undefined ? { costUsd: call.costUsd } : {}) }); return { chain: found.id }; }
    if (call.action === 'update_work' || call.action === 'complete_work' || call.action === 'set_timer') return (this.bots ?? fail(unavailableAssistants)).keepWork(hostId, call);
    if (call.action === 'update_mission') return (this.bots ?? fail(unavailableAssistants)).updateMission(hostId, call);
    if (call.action === 'list_bots') return (this.bots ?? fail(unavailableAssistants)).list(hostId, call);
    if (call.action === 'stop_bot' || call.action === 'retire_bot' || call.action === 'bot_session') return (this.bots ?? fail(unavailableAssistants)).manageStaff(hostId, call);
    if (call.action === 'task_status') return (this.tasks ?? fail(unavailableTasks)).status(hostId, call);
    if (call.action === 'report_task') { assertCurrent(); return (this.tasks ?? fail(unavailableTasks)).report(hostId, call); }
    if (call.action === 'open_room') { const rooms = this.rooms ?? fail(unavailableAssistants); return this.chained(hostId, call.owner, call.cause, () => rooms.open(hostId, call)); }
    if (call.action === 'room_say' || call.action === 'room_pass') return (this.rooms ?? fail(unavailableAssistants)).speak(hostId, call);
    if (call.action === 'list_assistants') return (this.assistants ?? fail(unavailableAssistants)).list(hostId, call);
    if (call.action === 'message_assistant') return (this.assistants ?? fail(unavailableAssistants)).message(hostId, call);
    if (call.action === 'message_task') return (this.tasks ?? fail(unavailableTasks)).message(hostId, call);
    if (call.action === 'cancel_task' || call.action === 'mark_task_done') return (this.tasks ?? fail(unavailableTasks)).finish(hostId, call);
    if (call.action === 'ask_owner') { assertCurrent(); return (this.tasks ?? fail(unavailableTasks)).ask(hostId, call); }
    if (call.action === 'tell_task') { assertCurrent(); return (this.tasks ?? fail(unavailableTasks)).tell(hostId, call); }
    if (call.action === 'resource_begin' || call.action === 'resource_chunk' || call.action === 'resource_finish' || call.action === 'resource_metadata' || call.action === 'resource_read') return this.resourceCall(hostId, call, assertCurrent);
    return this.change(teams => {
      assertCurrent();
      const team = find(teams, call.teamId), self = member(team, call.memberId), now = this.ports.now();
      if (self.hostId !== hostId || self.creation !== 'ready') fail('This Host is not the registered Team member.');
      if (!visible(team)) fail(tasksUpgrade);
      if (!recipientAware && !sameRecipient(this.resolveRecipientFromAnchor(self), self)) fail(upgradeRequired);
      if (call.action === 'read') return { ...this.project(team, recipientAware), receipts: team.deliveryReceipts?.map(({ fingerprint: _hash, settledAt: _time, ...receipt }) => projectDelivery(receipt)) ?? [] };
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
          if (!recipientAware && receipt!.resolvedTarget && nativeSessionRefKey(receipt!.resolvedTarget) !== nativeSessionRefKey(this.resolveRecipientFromAnchor(self))) fail(upgradeRequired);
          if (call.resolvedTarget && (!receipt!.resolvedTarget || nativeSessionRefKey(call.resolvedTarget) !== nativeSessionRefKey(receipt!.resolvedTarget))) fail('Team receipt recipient changed.');
          if (receipt!.status !== call.outcome) fail('Message is already settled.');
          const { fingerprint: _hash, settledAt: _time, ...result } = receipt!;
          return projectDelivery(result);
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
        else { if (!recipientAware && message.resolvedTarget && nativeSessionRefKey(message.resolvedTarget) !== nativeSessionRefKey(this.resolveRecipientFromAnchor(self))) fail(upgradeRequired); if (call.resolvedTarget && (!message.resolvedTarget || nativeSessionRefKey(call.resolvedTarget) !== nativeSessionRefKey(message.resolvedTarget))) fail('Team receipt recipient changed.'); if (message.status !== 'dispatching' && message.status !== 'unknown' && message.status !== call.outcome && !withdrawable(message, call.outcome)) fail('Message is already settled.'); message.status = call.outcome; if (message.acceptance !== 'started' && message.acceptance !== 'handled') message.acceptance = call.acceptance; message.error = call.error; }
        if (call.action === 'settle') taskSettled(team, message, now);
        return projectDelivery(message);
      }
      active(team);
      return fail('This Host call is not available.');
    });
  }
  private resourceAccess(team: SavedTeam, memberId: string, resourceId: string): TeamResource {
    const upload = team.resourceUploads?.find(item => item.resource.resourceId === resourceId);
    const grant = team.resourceGrants?.find(grant => grant.resourceId === resourceId);
    const referenced=!!grant || team.messages.some(message=>message.resources?.some(resource=>resource.resourceId===resourceId));
    if (!upload || !referenced && upload.expiresAt <= this.ports.now() || upload.ownerMemberId !== memberId && !grant?.memberIds.includes(memberId) && !team.messages.some(message => message.to === memberId && message.resources?.some(resource => resource.resourceId === resourceId))) fail('Resource access is not granted to this member.');
    return upload!.resource;
  }
  /** Verifies the stored bytes of resources a member may attach; keep pins them for as long as their Team exists. */
  private async pinResources(teamId: string, memberId: string, resourceIds: string[], keep = true): Promise<void> {
    const store = this.ports.resources ?? fail('Team resource storage is unavailable on this Relay.');
    for (const resourceId of resourceIds) {
      const team = structuredClone(find(this.ports.read(), teamId)); compactTeamDeliveries(team, this.ports.now());
      const ref = this.resourceAccess(team, memberId, resourceId);
      // An unpinned upload (a collected patch, a bundle) expires a day after its last use.
      const actual = await store.getMetadata(`team:${teamId}`, resourceId).catch(() => fail(`Resource ${resourceId} is no longer stored; collect or upload it again.`));
      if ((['resourceId', 'name', 'mediaType', 'sha256', 'byteLength'] as const).some(key => ref[key] !== actual[key])) fail('Resource metadata does not match stored bytes.');
      if (keep) await store.pin(`team:${teamId}`, resourceId);
    }
  }
  /**
   * Removed Teams' resources go with them. Every Team that no longer exists is swept, so resources a failed or interrupted sweep
   * left behind go with the next removal; a failure never fails the change that removed a Team.
   */
  private async retainResources(): Promise<void> {
    await this.ports.resources?.retain(() => this.ports.read().map(team => `team:${team.id}`)).catch(() => undefined);
  }
  private pruneResourceUploads(team:SavedTeam) {
    if(!team.resourceUploads)return;
    const referenced=new Set([...(team.resourceGrants ?? []).map(grant => grant.resourceId), ...team.messages.flatMap(message=>message.resources?.map(resource=>resource.resourceId)??[])]);
    team.resourceUploads=team.resourceUploads.filter(upload=>upload.expiresAt>this.ports.now()||referenced.has(upload.resource.resourceId));
  }
  private async resourceCall(hostId: string, call: Extract<TeamHostCall, { action: `resource_${string}` }>, assertCurrent: () => void): Promise<unknown> {
    const store = this.ports.resources ?? fail('Team resource storage is unavailable on this Relay.');
    // A member still being created may read what was granted to it, such as the bundle it starts from.
    const reading = call.action === 'resource_metadata' || call.action === 'resource_read';
    const authorize = () => {
      assertCurrent();
      const team = find(this.ports.read(), call.teamId), self = member(team, call.memberId);
      if (self.hostId !== hostId || self.creation !== 'ready' && !(reading && (self.creation === 'reserved' || self.creation === 'unknown'))) fail('This Host is not the registered Team member.');
      if (team.task && this.ports.tasks?.capable(hostId) !== true) fail(tasksUpgrade);
      return {team,self};
    };
    const {team,self} = authorize(), scope = `team:${team.id}`;
    if (call.action === 'resource_metadata' || call.action === 'resource_read') {
      this.resourceAccess(team,self.id,call.resourceId);
      const result = call.action === 'resource_metadata' ? await store.getMetadata(scope,call.resourceId) : await store.readChunk(scope,call.resourceId,call.offset);
      authorize(); return result;
    }
    active(team);
    if (call.action !== 'resource_begin' && call.action !== 'resource_chunk' && call.action !== 'resource_finish') throw new Error('Invalid resource operation.');
    const uploadId = createHash('sha256').update(JSON.stringify([self.id,call.operationId])).digest('hex');
    if (call.action === 'resource_begin') {
      const result = await store.begin(scope,{uploadId,name:call.name,mediaType:call.mediaType,byteLength:call.byteLength,sha256:call.sha256});authorize();
      await this.change(teams=>{assertCurrent();const current=find(teams,team.id);this.pruneResourceUploads(current);const existing=current.resourceUploads?.find(item=>item.resource.resourceId===result.resource?.resourceId);if(existing)existing.expiresAt=this.ports.now()+(this.ports.resourceDraftTtlMs??86400000);});return result;
    }
    if (call.action === 'resource_chunk') {const result=await store.chunk(scope,{uploadId,offset:call.offset,contentBase64:call.contentBase64});authorize();return result;}
    const result = await store.finish(scope,uploadId);
    if (!result.resource) fail('Resource upload is incomplete.');
    return this.change(teams => {
      assertCurrent();const current=find(teams,team.id),owner=member(current,self.id);active(current);
      if(owner.hostId!==hostId||owner.creation!=='ready')fail('This Host is not the registered Team member.');
      this.pruneResourceUploads(current);
      const uploads=current.resourceUploads??=[];
      if(!uploads.some(item=>item.resource.resourceId===result.resource!.resourceId)){
        if(uploads.length>=1024)fail('Team resource capacity reached.');
        uploads.push({ownerMemberId:self.id,expiresAt:this.ports.now()+(this.ports.resourceDraftTtlMs??86400000),resource:result.resource!});touch(current,this.ports.now());
      }
      return result;
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
        ...(team.task ? { task: { title: team.task.title } } : {}), ...(team.link ? { link: { peer: team.members.find(other => other.id !== item.id)!.name } } : {}), ...(team.room ? { room: { name: team.room.name } } : {}), ...(team.inbox ? { inbox: { botId: team.inbox.botId, ...(team.inbox.pending ? { mission: team.inbox.pending.mission } : {}) } } : {}) });
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
