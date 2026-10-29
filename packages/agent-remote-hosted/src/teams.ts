import { assertTeamQueueCapacity, compactTeamDeliveries, unresolvedTeamDelivery, stripPrivateTeamEvidence, replayTeamDelivery, validSavedTeam, type SavedTeam } from './team-delivery.js';
export { teamMessageBudgetBytes } from './team-delivery.js';
import type { TeamResourceStore } from './team-resources.js';
import { admitTeam, CallForSupportGroups, compactCallForSupport, pruneArchivedGroups, type CallForSupportPorts } from './call-for-support.js';
import { createHash, randomUUID } from 'node:crypto';
import { nativeSessionRefKey, type NativeSessionRef, isTeamMember, type Team, type TeamAction, type TeamCreate, type TeamHostCall, type TeamMember, type TeamMessage, type TeamSeat, type TeamResource } from '@orchardworks/agent-remote-protocol';

export interface TeamBrokerPorts {
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
  /** Absent: this Relay has no Call For Support groups. */
  callForSupport?: CallForSupportPorts;
}
const upgradeRequired = 'Update the Controller for exact Team recipients. Reload the browser after updating the Relay to inspect this Team safely.';
type StoredRecipientAnchor = Pick<TeamMember, 'hostId' | 'providerId' | 'nativeSessionId'>;
const withoutRecipient = <T extends { id: string; resolvedTarget?: NativeSessionRef }>(value: T): Omit<T, 'resolvedTarget'> => { const { resolvedTarget: _target, ...legacy } = value; return legacy; };
const fail = (message: string): never => { throw new Error(message); };

const unavailableGroups = 'Call For Support is unavailable on this Relay.';
const callForSupportUpgrade = 'Update the Controller to use Call For Support.';
const sameRecipient = (current: NativeSessionRef, anchor: StoredRecipientAnchor) => current.providerId === anchor.providerId && current.nativeSessionId === anchor.nativeSessionId;
const find = (teams: SavedTeam[], id: string) => teams.find(team => team.id === id) ?? fail('Team not found.');
const member = (team: Team, id: string) => team.members.find(item => item.id === id) ?? fail('Team member not found.');
const active = (team: Team) => { if (team.status !== 'active') fail('Team is not active.'); };
function touch(team: Team, now: number) { team.revision++; team.updatedAt = now; }
/** Queued input that never ran can still be reported undelivered when its recipient is stopped. */
const withdrawable = (message: TeamMessage, outcome: string) => message.status === 'accepted' && message.acceptance === 'queued' && outcome === 'rejected';
function settleArchive(team: SavedTeam, now: number) {
  if (team.status === 'archiving' && team.members.every(item => item.creation === 'abandoned' || item.creation === 'released' || item.creation === 'ready' && item.activity === 'idle' && item.updatedAt >= team.updatedAt)
    && ![...team.messages, ...(team.deliveryReceipts ?? [])].some(unresolvedTeamDelivery)) { team.status = 'archived'; touch(team, now); }
}

/** Membership authority and durable mailboxes; provider execution stays on Controllers. */
export class TeamBroker {
  private creating = new Map<string, Promise<Team>>();
  private readonly groups?: CallForSupportGroups;
  constructor(private readonly ports: TeamBrokerPorts) {
    if (ports.callForSupport) this.groups = new CallForSupportGroups({ ports, change: update => this.change(update), provision: (teamId, memberId) => this.provision(teamId, memberId),
      project: team => this.project(team), resource: (team, memberId, resourceId) => this.resourceAccess(team, memberId, resourceId),
      pinResources: (teamId, memberId, resourceIds, keep) => this.pinResources(teamId, memberId, resourceIds, keep) }, ports.callForSupport);
  }
  private async change<T>(update: (teams: SavedTeam[]) => T): Promise<T> {
    let removed = false;
    const value = await this.ports.change(teams => {
      for (const team of teams) compactTeamDeliveries(team, this.ports.now());
      const existing = teams.map(team => team.id);
      const result = update(teams);
      for (const team of teams) { compactTeamDeliveries(team, this.ports.now()); compactCallForSupport(team); }
      pruneArchivedGroups(teams);
      const remaining = new Set(teams.map(team => team.id));
      removed = existing.some(id => !remaining.has(id));
      return result;
    });
    if (removed) await this.retainResources();
    return value;
  }
  private project(saved: SavedTeam, recipientAware = true): Team {
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
  async create(input: TeamCreate): Promise<Team> {
    if (input.callForSupport) {
      const groups = this.groups ?? fail(unavailableGroups);
      return (await groups.call({ operationId: input.operationId, source: input.source, profileId: input.callForSupport.profileId, call: input.callForSupport.call, origin: 'user',
        ...(input.callForSupport.fresh ? { fresh: true } : {}) })).team;
    }
    this.ports.assertHost(input.source.hostId, input.source.providerId);
    const team = await this.change(teams => {
      const existing = teams.find(item => item.operationId === input.operationId);
      if (existing) { if (JSON.stringify(existing.source) !== JSON.stringify(input.source)) fail('Creation identity has different input.'); return existing; }
      admitTeam(teams);
      const now = this.ports.now();
      const leader: TeamMember = { id: randomUUID(), role: 'leader', hostId: input.source.hostId, providerId: input.source.providerId,
        name: 'Leader', responsibility: 'Discuss requirements, implement directly, coordinate members, validate and report delivery.',
        creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now };
      const created: SavedTeam = { id: randomUUID(), operationId: input.operationId, revision: 1, source: input.source, title: 'New team', status: 'active', members: [leader], messages: [], createdAt: now, updatedAt: now };
      teams.push(created); return created;
    });
    return this.provision(team.id, team.members[0]!.id);
  }
  async action(input: TeamAction): Promise<Team> {
    if (input.action === 'call_for_support') {
      const groups = this.groups ?? fail(unavailableGroups);
      return groups.userCall(input.teamId, { operationId: input.operationId, task: input.task, ...(input.context ? { context: input.context } : {}), deliverable: input.deliverable,
        ...(input.followUpOf ? { followUpOf: input.followUpOf } : {}) });
    }
    if (input.action === 'resolve_roster' || input.action === 'release_member' || input.action === 'update_mandate' || input.action === 'resume_group') return (this.groups ?? fail(unavailableGroups)).userAction(input);
    if (input.action === 'add_member') this.ports.assertHost(input.hostId, input.providerId);
    const result = await this.change(teams => {
      const team = find(teams, input.teamId), now = this.ports.now();
      if (input.action === 'archive') {
        if (team.status === 'active') { team.status = 'archiving'; for (const message of team.messages) if (message.status === 'queued') message.status = 'canceled'; touch(team, now); }
      } else if (input.action === 'restore') {
        if (team.status !== 'archived') fail('Finish archiving before restoring this Team.');
        // Controllers forget an archived group's seats, and the Relay removes archived groups to make room.
        if (team.callForSupport) fail('An archived support group cannot be restored. Call for support again to start a new group.');
        team.status = 'active'; touch(team, now);
      }
      else if (input.action === 'rename') { team.title = input.title; touch(team, now); }
      else if (input.action === 'add_member') {
        active(team);
        const existing = team.members.find(item => item.id === input.operationId);
        if (existing) { if (existing.hostId !== input.hostId || existing.providerId !== input.providerId || existing.cwd !== input.cwd || existing.name !== input.name) fail('Member creation identity has different input.'); }
        else { if (team.members.length >= 12) fail('Member capacity reached.'); team.members.push({ id: input.operationId, hostId: input.hostId, providerId: input.providerId, cwd: input.cwd, name: input.name,
          responsibility: input.responsibility, role: 'member', creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now }); touch(team, now); }
      } else if (input.action === 'abandon_creation') {
        const item = member(team, input.memberId); if (item.creation === 'ready') fail('A registered member cannot be abandoned.'); item.creation = 'abandoned'; item.activity = 'idle'; item.updatedAt = now;
      } else if (input.action === 'resolve_message') {
        const receipt = team.deliveryReceipts?.find(item => item.id === input.messageId);
        const message = team.messages.find(item => item.id === input.messageId) ?? receipt ?? fail('Message not found.');
        if (!unresolvedTeamDelivery(message)) fail('Message does not require resolution.');
        message.status = input.outcome; message.acceptance = input.outcome === 'accepted' ? 'handled' : undefined; message.error = 'Resolved explicitly by the user.';
        if (receipt) receipt.settledAt = now;
      } else if (input.action === 'retry_creation') { active(team); if (member(team, input.memberId).creation === 'abandoned') fail('Member was abandoned.'); }
      settleArchive(team, now); return team;
    });
    return input.action === 'add_member' ? this.provision(result.id, input.operationId) : input.action === 'retry_creation' ? this.provision(result.id, input.memberId) : this.project(result);
  }
  async hostCall(hostId: string, call: TeamHostCall, assertCurrent: () => void = () => {}, recipientAware = true): Promise<unknown> {
    assertCurrent();
    if (!recipientAware && (call.action === 'claim' && call.expectedNativeSessionId !== undefined || call.action === 'settle' && call.resolvedTarget)) fail(upgradeRequired);
    // A Controller that does not run Call For Support groups never sees them.
    const visible = (team: SavedTeam) => !team.callForSupport || this.ports.callForSupport?.capable(hostId) === true;
    // A released member's Host keeps seeing its Team, to clean up what the member left.
    if (call.action === 'poll') return this.ports.read().filter(team => team.status !== 'archived' && visible(team) && team.members.some(item => item.hostId === hostId && (item.creation === 'ready' || item.creation === 'released'))).map(team => this.project(team, recipientAware));
    const projectDelivery = <T extends { id: string; resolvedTarget?: NativeSessionRef }>(value: T) => recipientAware ? value : withoutRecipient(value);
    if (call.action === 'call_for_support' || call.action === 'support_status') return (this.groups ?? fail(unavailableGroups)).workerCall(hostId, call);
    if (call.action === 'support_enablement') return (this.groups ?? fail(unavailableGroups)).enablement(hostId);
    if (call.action === 'support_group_states') return (this.groups ?? fail(unavailableGroups)).groupStates(hostId, call.teamIds);
    if (call.action === 'propose_roster' || call.action === 'release_supporter' || call.action === 'report_support' || call.action === 'write_ledger' || call.action === 'report_usage' || call.action === 'collect_supporter_patch') {
      assertCurrent(); return (this.groups ?? fail(unavailableGroups)).memberCall(hostId, call);
    }
    if (call.action === 'resource_begin' || call.action === 'resource_chunk' || call.action === 'resource_finish' || call.action === 'resource_metadata' || call.action === 'resource_read') return this.resourceCall(hostId, call, assertCurrent);
    if (call.action === 'send' && call.resources?.length) await this.prepareResources(hostId,call,assertCurrent);
    return this.change(teams => {
      assertCurrent();
      const team = find(teams, call.teamId), self = member(team, call.memberId), now = this.ports.now();
      if (self.hostId !== hostId || self.creation !== 'ready') fail('This Host is not the registered Team member.');
      if (!visible(team)) fail(callForSupportUpgrade);
      if (!recipientAware && !sameRecipient(this.resolveRecipientFromAnchor(self), self)) fail(upgradeRequired);
      if (call.action === 'read') return { ...this.project(team, recipientAware), receipts: team.deliveryReceipts?.map(({ fingerprint: _hash, settledAt: _time, ...receipt }) => projectDelivery(receipt)) ?? [] };
      if (call.action === 'acknowledge') {
        if (!recipientAware) fail(upgradeRequired);
        const target = this.resolveRecipientFromAnchor(self);
        if (target.nativeSessionId !== call.expectedNativeSessionId) fail('Team recipient moved or does not match the acknowledgement.');
        this.ports.assertRecipient?.(target);
        // Validate the whole batch before consuming any input. A native claim owns its effect boundary.
        const messages = call.messageIds.map(id => {
          const message = team.messages.find(item => item.id === id) ?? team.deliveryReceipts?.find(item => item.id === id);
          if (!message) return fail('Message acknowledgement is unavailable. Read the current inbox before retrying.');
          if (message.to !== self.id) fail('Message is not addressed to this member.');
          if (message.resolvedTarget && nativeSessionRefKey(message.resolvedTarget) !== nativeSessionRefKey(target)) fail('Message belongs to a different Team recipient.');
          if (message.status === 'queued') { active(team); return message; }
          if (message.status === 'accepted' && ['started', 'handled'].includes(message.acceptance ?? '') && message.resolvedTarget) return message;
          if (unresolvedTeamDelivery(message)) fail('Message has entered native delivery. Inspect its receipt; do not resend or acknowledge it as unread.');
          return fail('Message was not accepted and cannot be acknowledged as received.');
        });
        let changed = false;
        for (const message of messages) if (message.status === 'queued') {
          message.resolvedTarget = structuredClone(target); message.status = 'accepted'; message.acceptance = 'handled'; changed = true;
        }
        if (changed) touch(team, now);
        return { acknowledged: messages.map(message => ({ id: message.id, from: message.from, to: message.to,
          status: message.status, acceptance: message.acceptance, createdAt: message.createdAt, resolvedTarget: message.resolvedTarget })) };
      }
      if (call.action === 'presence') { if (self.activity === call.activity && team.status !== 'archiving') return team.status; self.activity = call.activity; self.updatedAt = now; settleArchive(team, now); return team.status; }
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
          if (team.callForSupport?.status === 'paused_budget' && self.role !== 'requester') fail('Support is paused by its budget.');
          const target = this.resolveRecipientFromAnchor(self);
          if (call.expectedNativeSessionId === undefined ? target.nativeSessionId !== self.nativeSessionId : call.expectedNativeSessionId !== target.nativeSessionId) fail('Team recipient moved or does not match the claim.');
          this.ports.assertRecipient?.(target);
          message.resolvedTarget = structuredClone(target); message.status = 'dispatching'; self.activity = 'busy';
        }
        else { if (!recipientAware && message.resolvedTarget && nativeSessionRefKey(message.resolvedTarget) !== nativeSessionRefKey(this.resolveRecipientFromAnchor(self))) fail(upgradeRequired); if (call.resolvedTarget && (!message.resolvedTarget || nativeSessionRefKey(call.resolvedTarget) !== nativeSessionRefKey(message.resolvedTarget))) fail('Team receipt recipient changed.'); if (message.status !== 'dispatching' && message.status !== 'unknown' && message.status !== call.outcome && !withdrawable(message, call.outcome)) fail('Message is already settled.'); message.status = call.outcome; if (message.acceptance !== 'started' && message.acceptance !== 'handled') message.acceptance = call.acceptance; message.error = call.error; }
        return projectDelivery(message);
      }
      active(team);
      if (call.action === 'send') {
        const target = member(team, call.to);
        if (self.role === 'requester') fail('The worker calls for support with call_for_support.');
        if (target.role === 'requester') fail('Reports reach the worker through report_support.');
        if (target.id === self.id || self.role !== 'leader' && target.role !== 'leader') fail('Members can communicate only with their Leader.');
        if (target.creation !== 'ready') fail('Target member is not registered.');
        const id = createHash('sha256').update(JSON.stringify([self.id, call.operationId])).digest('hex');
        const replay = replayTeamDelivery(team, id, call);
        if (replay) return projectDelivery(replay);
        const resources = call.resources?.map(resourceId => this.resourceAccess(team, self.id, resourceId));
        if (resources && (new Set(resources.map(resource => resource.resourceId)).size !== resources.length || resources.reduce((total, resource) => total + resource.byteLength, 0) > 100 * 1024 * 1024)) fail('Resource attachment limit exceeded.');
        const existing = team.messages.find(message => message.id === id);
        if (existing) { if (existing.to !== call.to || existing.text !== call.text || JSON.stringify(existing.resources) !== JSON.stringify(resources)) fail('Message identity has different input.'); return projectDelivery(existing); }
        const message = { id, from: self.id, to: call.to, text: call.text, ...(resources ? {resources} : {}), status: 'queued' as const, createdAt: now }; assertTeamQueueCapacity(team, message); team.messages.push(message); touch(team, now); return projectDelivery(message);
      }
      if (call.action === 'describe_member') { if (self.role !== 'leader') fail('Only the Leader defines member responsibilities.'); member(team, call.target).responsibility = call.responsibility; }
      if (call.action === 'report') { self.summary = call.summary; self.updatedAt = now; }
      touch(team, now); return this.project(team, recipientAware);
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
      const ref = this.resourceAccess(team, memberId, resourceId), actual = await store.getMetadata(`team:${teamId}`, resourceId);
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
  private async prepareResources(hostId:string,call:Extract<TeamHostCall,{action:'send'}>,assertCurrent:()=>void) {
    const check=()=>{
      assertCurrent();const team=structuredClone(find(this.ports.read(),call.teamId));compactTeamDeliveries(team,this.ports.now());const self=member(team,call.memberId),target=member(team,call.to);active(team);
      if(self.hostId!==hostId||self.creation!=='ready')fail('This Host is not the registered Team member.');
      if(target.id===self.id||self.role!=='leader'&&target.role!=='leader')fail('Members can communicate only with their Leader.');
      if(target.creation!=='ready')fail('Target member is not registered.');
      const id=createHash('sha256').update(JSON.stringify([self.id,call.operationId])).digest('hex');
      const replay=replayTeamDelivery(team,id,call);if(replay)return {team,existing:replay};
      const existing=team.messages.find(message=>message.id===id);
      if(existing){if(existing.to!==call.to||existing.text!==call.text||JSON.stringify(existing.resources?.map(resource=>resource.resourceId))!==JSON.stringify(call.resources))fail('Message identity has different input.');return {team,existing};}
      assertTeamQueueCapacity(team,{id,from:self.id,to:call.to,text:call.text,status:'queued',createdAt:this.ports.now()});
      return {team};
    };
    const initial=check();if(initial.existing)return;
    const refs=call.resources!.map(id=>this.resourceAccess(initial.team,call.memberId,id));
    if(refs.length>8||new Set(call.resources).size!==refs.length||refs.reduce((size,ref)=>size+ref.byteLength,0)>100*1024*1024)fail('Resource attachment limit exceeded.');
    const store=this.ports.resources??fail('Team resource storage is unavailable on this Relay.');
    for(const ref of refs){const current=check();this.resourceAccess(current.team,call.memberId,ref.resourceId);const actual=await store.getMetadata(`team:${call.teamId}`,ref.resourceId);
      if((['resourceId','name','mediaType','sha256','byteLength'] as const).some(key=>ref[key]!==actual[key]))fail('Resource metadata does not match stored bytes.');
      await store.pin(`team:${call.teamId}`,ref.resourceId);
    }
    check();
  }
  private async resourceCall(hostId: string, call: Extract<TeamHostCall, { action: `resource_${string}` }>, assertCurrent: () => void): Promise<unknown> {
    const store = this.ports.resources ?? fail('Team resource storage is unavailable on this Relay.');
    // A member still being created may read what was granted to it, such as the bundle it starts from.
    const reading = call.action === 'resource_metadata' || call.action === 'resource_read';
    const authorize = () => {
      assertCurrent();
      const team = find(this.ports.read(), call.teamId), self = member(team, call.memberId);
      if (self.hostId !== hostId || self.creation !== 'ready' && !(reading && (self.creation === 'reserved' || self.creation === 'unknown'))) fail('This Host is not the registered Team member.');
      if (team.callForSupport && this.ports.callForSupport?.capable(hostId) !== true) fail(callForSupportUpgrade);
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
        ...(team.callForSupport ? { callForSupport: { role: team.callForSupport.role, description: team.callForSupport.description } } : {}) });
      if (!isTeamMember(result) || result.id !== item.id || result.hostId !== item.hostId || result.providerId !== item.providerId || result.role !== item.role || result.creation !== 'ready' || !result.nativeSessionId) fail('Invalid Host member registration.');
    } catch (error) { result = { ...item, creation: 'unknown', error: error instanceof Error ? error.message.slice(0, 2048) : 'Member creation is uncertain.' }; }
    return this.change(teams => {
      const current = find(teams, teamId), slot = member(current, memberId);
      // A worker may have several support roles; any other session holds one Team seat.
      if (result.creation === 'ready' && teams.some(other => other.members.some(candidate => candidate !== slot && candidate.creation === 'ready' && candidate.hostId === result.hostId && candidate.providerId === result.providerId && candidate.nativeSessionId === result.nativeSessionId
        && (candidate.role !== 'requester' || result.role !== 'requester')))) fail('Native session is already bound to a Team member.');
      const registering = slot.creation !== 'ready' && slot.creation !== 'abandoned' && result.creation === 'ready';
      if (slot.creation !== 'abandoned') Object.assign(slot, result);
      if (registering && result.role === 'member' && current.status === 'active') {
        const leader = current.members[0]!;
        const registration = { id: createHash('sha256').update(JSON.stringify(['registration', result.id])).digest('hex'), from: result.id, to: leader.id,
          text: `Team member registered: ${result.name}. Host: ${result.hostId}. Provider: ${result.providerId}. Working directory: ${result.cwd || 'Host default'}. Responsibility: ${result.responsibility || 'Not defined yet; discuss with the user before assigning work.'}`, status: 'queued' as const, createdAt: this.ports.now() };
        assertTeamQueueCapacity(current,registration);current.messages.push(registration);
      }
      // An archive may have started while native creation was in progress. Never reactivate it.
      if (current.status === 'active') touch(current, this.ports.now());
      if (!validSavedTeam(current)) fail('Invalid Team state.'); return this.project(current);
    });
  }
}
