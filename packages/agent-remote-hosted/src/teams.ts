import { assertTeamQueueCapacity, compactTeamDeliveries, unresolvedTeamDelivery, publicTeam, replayTeamDelivery, validSavedTeam, type SavedTeam } from './team-delivery.js';
export { teamMessageBudgetBytes } from './team-delivery.js';
import type { TeamResourceStore } from './team-resources.js';
import { createHash, randomUUID } from 'node:crypto';
import { nativeSessionRefKey, type NativeSessionRef, isTeamMember, type Team, type TeamAction, type TeamCreate, type TeamHostCall, type TeamMember, type TeamSeat, type TeamResource } from '@orchardworks/agent-remote-protocol';

export interface TeamBrokerPorts {
  resolveSession(hostId: string, providerId: string, anchorNativeId: string): NativeSessionRef;
  assertRecipient?(target: NativeSessionRef): void;
  assertRecipientSupport?(hostId: string): void;
  resources?: TeamResourceStore;
  resourceDraftTtlMs?: number;
  read(): SavedTeam[];
  change<T>(update: (teams: SavedTeam[]) => T): Promise<T>;
  createSeat(hostId: string, seat: TeamSeat): Promise<TeamMember>;
  assertHost(hostId: string, providerId: string): void;
  now(): number;
}
const upgradeRequired = 'Update the Controller for exact Team recipients. Reload the browser after updating the Relay to inspect this Team safely.';
const withoutRecipient = <T extends { id: string; resolvedTarget?: NativeSessionRef }>(value: T): Omit<T, 'resolvedTarget'> => { const { resolvedTarget: _target, ...legacy } = value; return legacy; };
const fail = (message: string): never => { throw new Error(message); };
const find = (teams: SavedTeam[], id: string) => teams.find(team => team.id === id) ?? fail('Team not found.');
const member = (team: Team, id: string) => team.members.find(item => item.id === id) ?? fail('Team member not found.');
const active = (team: Team) => { if (team.status !== 'active') fail('Team is not active.'); };
function touch(team: Team, now: number) { team.revision++; team.updatedAt = now; }
function settleArchive(team: SavedTeam, now: number) {
  if (team.status === 'archiving' && team.members.every(item => item.creation === 'abandoned' || item.creation === 'ready' && item.activity === 'idle' && item.updatedAt >= team.updatedAt)
    && ![...team.messages, ...(team.deliveryReceipts ?? [])].some(unresolvedTeamDelivery)) { team.status = 'archived'; touch(team, now); }
}

/** Membership authority and durable mailboxes; provider execution stays on Controllers. */
export class TeamBroker {
  private creating = new Map<string, Promise<Team>>();
  constructor(private readonly ports: TeamBrokerPorts) {}
  private change<T>(update: (teams: SavedTeam[]) => T): Promise<T> {
    return this.ports.change(teams => {
      for (const team of teams) compactTeamDeliveries(team, this.ports.now());
      const result = update(teams);
      for (const team of teams) compactTeamDeliveries(team, this.ports.now());
      return result;
    });
  }
  private project(saved: SavedTeam, recipientAware = true): Team {
    const team = structuredClone(publicTeam(saved));
    const unresolved = (saved.deliveryReceipts ?? []).flatMap(receipt => {
      if (receipt.status !== 'accepted' || receipt.acceptance !== undefined) return [];
      const { fingerprint: _hash, settledAt: _time, acceptance: _disposition, ...evidence } = receipt;
      return [{ ...evidence, status: receipt.status }];
    });
    if (unresolved.length) team.unresolvedReceipts = structuredClone(unresolved);
    if (!recipientAware) {
      if (unresolved.length || team.members.some(member => {
        if (!member.nativeSessionId) return member.creation === 'ready';
        if (member.nativeSessionId.length > 256) return true;
        try { return this.resolve(member).nativeSessionId !== member.nativeSessionId; }
        catch { return false; } // Offline seats retain their persisted anchor for read-only display.
      })) fail(upgradeRequired);
      team.messages = team.messages.map(withoutRecipient);
      return team;
    }
    for (const member of team.members) if (member.nativeSessionId) {
      try { member.nativeSessionId = this.resolve(member).nativeSessionId; }
      catch { delete member.nativeSessionId; }
    }
    return team;
  }
  private resolve(member: TeamMember): NativeSessionRef {
    if (!member.nativeSessionId) fail('Team recipient is unavailable.');
    const target = this.ports.resolveSession(member.hostId, member.providerId, member.nativeSessionId!);
    if (target.providerId !== member.providerId) fail('Team recipient provider changed.');
    return target;
  }
  hasUnsettledRecipient(target: NativeSessionRef): boolean {
    return this.ports.read().some(team => [...team.messages, ...(team.deliveryReceipts ?? [])].some(message => {
      if (!unresolvedTeamDelivery(message)) return false;
      if (message.resolvedTarget) return nativeSessionRefKey(message.resolvedTarget) === nativeSessionRefKey(target);
      const seat = member(team, message.to);
      if (seat.providerId !== target.providerId) return false;
      try {
        const actual = this.ports.resolveSession(seat.hostId, target.providerId, target.nativeSessionId);
        if (actual.controllerId !== target.controllerId) return false;
        const anchor = this.ports.resolveSession(seat.hostId, seat.providerId, seat.nativeSessionId!);
        return nativeSessionRefKey(anchor) === nativeSessionRefKey(actual);
      } catch { return true; }
    }));
  }
  forClient(team: Team, recipientAware: boolean): Team { return this.project(find(this.ports.read(), team.id), recipientAware); }
  assertReplacementSupported(target: NativeSessionRef, hostId: string): void {
    for (const team of this.ports.read()) for (const seat of team.members) {
      if (seat.hostId === hostId && seat.providerId === target.providerId && seat.creation === 'ready' && nativeSessionRefKey(this.resolve(seat)) === nativeSessionRefKey(target)) this.ports.assertRecipientSupport?.(seat.hostId);
    }
  }
  list(recipientAware = true): Team[] { return this.ports.read().map(saved => {
    const team = structuredClone(saved); compactTeamDeliveries(team, this.ports.now()); return this.project(team, recipientAware);
  }); }
  async create(input: TeamCreate): Promise<Team> {
    this.ports.assertHost(input.source.hostId, input.source.providerId);
    const team = await this.change(teams => {
      const existing = teams.find(item => item.operationId === input.operationId);
      if (existing) { if (JSON.stringify(existing.source) !== JSON.stringify(input.source)) fail('Creation identity has different input.'); return existing; }
      if (teams.length >= 32) fail('Team capacity reached.');
      const now = this.ports.now();
      const leader: TeamMember = { id: randomUUID(), role: 'leader', hostId: input.source.hostId, providerId: input.source.providerId,
        name: 'Leader', responsibility: 'Discuss requirements, implement directly, coordinate members, validate and report delivery.',
        creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now };
      const created: Team = { id: randomUUID(), operationId: input.operationId, revision: 1, source: input.source, title: 'New team', status: 'active', members: [leader], messages: [], createdAt: now, updatedAt: now };
      teams.push(created); return created;
    });
    return this.provision(team.id, team.members[0]!.id);
  }
  async action(input: TeamAction): Promise<Team> {
    if (input.action === 'add_member') this.ports.assertHost(input.hostId, input.providerId);
    const result = await this.change(teams => {
      const team = find(teams, input.teamId), now = this.ports.now();
      if (input.action === 'archive') {
        if (team.status === 'active') { team.status = 'archiving'; for (const message of team.messages) if (message.status === 'queued') message.status = 'canceled'; touch(team, now); }
      } else if (input.action === 'restore') { if (team.status !== 'archived') fail('Finish archiving before restoring this Team.'); team.status = 'active'; touch(team, now); }
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
    if (call.action === 'poll') return this.ports.read().filter(team => team.status !== 'archived' && team.members.some(item => item.hostId === hostId && item.creation === 'ready')).map(team => this.project(team, recipientAware));
    const projectDelivery = <T extends { id: string; resolvedTarget?: NativeSessionRef }>(value: T) => recipientAware ? value : withoutRecipient(value);
    if (call.action.startsWith('resource_')) return this.resourceCall(hostId, call, assertCurrent);
    if (call.action === 'send' && call.resources?.length) await this.prepareResources(hostId,call,assertCurrent);
    return this.change(teams => {
      assertCurrent();
      const team = find(teams, call.teamId), self = member(team, call.memberId), now = this.ports.now();
      if (self.hostId !== hostId || self.creation !== 'ready') fail('This Host is not the registered Team member.');
      if (!recipientAware && this.resolve(self).nativeSessionId !== self.nativeSessionId) fail(upgradeRequired);
      if (call.action === 'read') return { ...this.project(team, recipientAware), receipts: team.deliveryReceipts?.map(({ fingerprint: _hash, settledAt: _time, ...receipt }) => projectDelivery(receipt)) ?? [] };
      if (call.action === 'presence') { if (self.activity === call.activity && team.status !== 'archiving') return team.status; self.activity = call.activity; self.updatedAt = now; settleArchive(team, now); return team.status; }
      if (call.action === 'settle' || call.action === 'claim') {
        const message = team.messages.find(item => item.id === call.messageId && item.to === self.id);
        if (!message) {
          const receipt = team.deliveryReceipts?.find(item => item.id === call.messageId && item.to === self.id);
          if (!receipt) fail('Message is not addressed to this member.');
          if (call.action === 'claim') return fail('Message is already settled.');
          if (!recipientAware && receipt!.resolvedTarget && nativeSessionRefKey(receipt!.resolvedTarget) !== nativeSessionRefKey(this.resolve(self))) fail(upgradeRequired);
          if (call.resolvedTarget && (!receipt!.resolvedTarget || nativeSessionRefKey(call.resolvedTarget) !== nativeSessionRefKey(receipt!.resolvedTarget))) fail('Team receipt recipient changed.');
          if (receipt!.status !== call.outcome) fail('Message is already settled.');
          const { fingerprint: _hash, settledAt: _time, ...result } = receipt!;
          return projectDelivery(result);
        }
        if (call.action === 'claim') {
          active(team); if (message.status !== 'queued') fail('Message is already claimed.');
          const target = this.resolve(self);
          if (call.expectedNativeSessionId === undefined ? target.nativeSessionId !== self.nativeSessionId : call.expectedNativeSessionId !== target.nativeSessionId) fail('Team recipient moved or does not match the claim.');
          this.ports.assertRecipient?.(target);
          message.resolvedTarget = structuredClone(target); message.status = 'dispatching'; self.activity = 'busy';
        }
        else { if (!recipientAware && message.resolvedTarget && nativeSessionRefKey(message.resolvedTarget) !== nativeSessionRefKey(this.resolve(self))) fail(upgradeRequired); if (call.resolvedTarget && (!message.resolvedTarget || nativeSessionRefKey(call.resolvedTarget) !== nativeSessionRefKey(message.resolvedTarget))) fail('Team receipt recipient changed.'); if (message.status !== 'dispatching' && message.status !== 'unknown' && message.status !== call.outcome) fail('Message is already settled.'); message.status = call.outcome; if (message.acceptance !== 'started' && message.acceptance !== 'handled') message.acceptance = call.acceptance; message.error = call.error; }
        return projectDelivery(message);
      }
      active(team);
      if (call.action === 'send') {
        const target = member(team, call.to);
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
  private async resourceCall(hostId: string, call: TeamHostCall, assertCurrent: () => void): Promise<unknown> {
    if (call.action === 'poll') throw new Error('Invalid resource call.');
    const store = this.ports.resources ?? fail('Team resource storage is unavailable on this Relay.');
    const authorize = () => {
      assertCurrent();
      const team = find(this.ports.read(), call.teamId), self = member(team, call.memberId);
      if (self.hostId !== hostId || self.creation !== 'ready') fail('This Host is not the registered Team member.');
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
    const team = find(this.list(), teamId), item = member(team, memberId); active(team);
    if (item.creation === 'ready') return team;
    let result: TeamMember;
    try {
      result = await this.ports.createSeat(item.hostId, { teamId, source: team.source, member: item });
      if (!isTeamMember(result) || result.id !== item.id || result.hostId !== item.hostId || result.providerId !== item.providerId || result.role !== item.role || result.creation !== 'ready' || !result.nativeSessionId) fail('Invalid Host member registration.');
    } catch (error) { result = { ...item, creation: 'unknown', error: error instanceof Error ? error.message.slice(0, 2048) : 'Member creation is uncertain.' }; }
    return this.change(teams => {
      const current = find(teams, teamId), slot = member(current, memberId);
      if (result.creation === 'ready' && teams.some(other => other.members.some(candidate => candidate !== slot && candidate.creation === 'ready' && candidate.hostId === result.hostId && candidate.providerId === result.providerId && candidate.nativeSessionId === result.nativeSessionId))) fail('Native session is already bound to a Team member.');
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
