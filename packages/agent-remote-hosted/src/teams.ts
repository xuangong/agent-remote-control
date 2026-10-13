import type { TeamResourceStore } from './team-resources.js';
import { createHash, randomUUID } from 'node:crypto';
import { isTeam, isTeamMember, type Team, type TeamAction, type TeamCreate, type TeamHostCall, type TeamMember, type TeamSeat, type TeamResource } from '@orchardworks/agent-remote-protocol';

export interface TeamBrokerPorts {
  resources?: TeamResourceStore;
  resourceDraftTtlMs?: number;
  read(): Team[];
  change<T>(update: (teams: Team[]) => T): Promise<T>;
  createSeat(hostId: string, seat: TeamSeat): Promise<TeamMember>;
  assertHost(hostId: string, providerId: string): void;
  now(): number;
}
const fail = (message: string): never => { throw new Error(message); };
const find = (teams: Team[], id: string) => teams.find(team => team.id === id) ?? fail('Team not found.');
const member = (team: Team, id: string) => team.members.find(item => item.id === id) ?? fail('Team member not found.');
export const teamMessageBudgetBytes = (team: Team) => Buffer.byteLength(JSON.stringify(team.messages.map(({resources: _resources, ...message}) => message)));
const active = (team: Team) => { if (team.status !== 'active') fail('Team is not active.'); };
function touch(team: Team, now: number) { team.revision++; team.updatedAt = now; }
function settleArchive(team: Team, now: number) {
  if (team.status === 'archiving' && team.members.every(item => item.creation === 'abandoned' || item.creation === 'ready' && item.activity === 'idle' && item.updatedAt >= team.updatedAt)
    && !team.messages.some(message => (['dispatching', 'unknown'].includes(message.status) || message.status === 'accepted' && message.acceptance === 'queued'))) { team.status = 'archived'; touch(team, now); }
}

/** Membership authority and durable mailboxes; provider execution stays on Controllers. */
export class TeamBroker {
  private creating = new Map<string, Promise<Team>>();
  constructor(private readonly ports: TeamBrokerPorts) {}
  list(): Team[] { return structuredClone(this.ports.read()); }
  async create(input: TeamCreate): Promise<Team> {
    this.ports.assertHost(input.source.hostId, input.source.providerId);
    const team = await this.ports.change(teams => {
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
    const result = await this.ports.change(teams => {
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
        const message = team.messages.find(item => item.id === input.messageId) ?? fail('Message not found.');
        if (!['unknown', 'dispatching'].includes(message.status) && message.acceptance !== 'queued') fail('Message does not require resolution.');
        message.status = input.outcome; message.acceptance = input.outcome === 'accepted' ? 'handled' : undefined; message.error = 'Resolved explicitly by the user.';
      } else if (input.action === 'retry_creation') { active(team); if (member(team, input.memberId).creation === 'abandoned') fail('Member was abandoned.'); }
      settleArchive(team, now); return team;
    });
    return input.action === 'add_member' ? this.provision(result.id, input.operationId) : input.action === 'retry_creation' ? this.provision(result.id, input.memberId) : result;
  }
  async hostCall(hostId: string, call: TeamHostCall, assertCurrent: () => void = () => {}): Promise<unknown> {
    assertCurrent();
    if (call.action === 'poll') return this.list().filter(team => team.status !== 'archived' && team.members.some(item => item.hostId === hostId && item.creation === 'ready'));
    if (call.action.startsWith('resource_')) return this.resourceCall(hostId, call, assertCurrent);
    if (call.action === 'send' && call.resources?.length) await this.prepareResources(hostId,call,assertCurrent);
    return this.ports.change(teams => {
      assertCurrent();
      const team = find(teams, call.teamId), self = member(team, call.memberId), now = this.ports.now();
      if (self.hostId !== hostId || self.creation !== 'ready') fail('This Host is not the registered Team member.');
      if (call.action === 'read') return team;
      if (call.action === 'presence') { if (self.activity === call.activity && team.status !== 'archiving') return team.status; self.activity = call.activity; self.updatedAt = now; settleArchive(team, now); return team.status; }
      if (call.action === 'settle' || call.action === 'claim') {
        const message = team.messages.find(item => item.id === call.messageId && item.to === self.id) ?? fail('Message is not addressed to this member.');
        if (call.action === 'claim') { active(team); if (message.status !== 'queued') fail('Message is already claimed.'); message.status = 'dispatching'; self.activity = 'busy'; }
        else { if (message.status !== 'dispatching' && message.status !== 'unknown' && message.status !== call.outcome) fail('Message is already settled.'); message.status = call.outcome; if (message.acceptance !== 'started' && message.acceptance !== 'handled') message.acceptance = call.acceptance; message.error = call.error; }
        return message;
      }
      active(team);
      if (call.action === 'send') {
        const target = member(team, call.to);
        if (target.id === self.id || self.role !== 'leader' && target.role !== 'leader') fail('Members can communicate only with their Leader.');
        if (target.creation !== 'ready') fail('Target member is not registered.');
        const resources = call.resources?.map(resourceId => this.resourceAccess(team, self.id, resourceId));
        if (resources && (new Set(resources.map(resource => resource.resourceId)).size !== resources.length || resources.reduce((total, resource) => total + resource.byteLength, 0) > 100 * 1024 * 1024)) fail('Resource attachment limit exceeded.');
        const id = createHash('sha256').update(JSON.stringify([self.id, call.operationId])).digest('hex');
        const existing = team.messages.find(message => message.id === id);
        if (existing) { if (existing.to !== call.to || existing.text !== call.text || JSON.stringify(existing.resources) !== JSON.stringify(resources)) fail('Message identity has different input.'); return existing; }
        if (team.messages.length >= 200 || teamMessageBudgetBytes(team) + Buffer.byteLength(call.text) > 128 * 1024) fail('Team communication capacity reached.');
        const message = { id, from: self.id, to: call.to, text: call.text, ...(resources ? {resources} : {}), status: 'queued' as const, createdAt: now }; team.messages.push(message); touch(team, now); return message;
      }
      if (call.action === 'describe_member') { if (self.role !== 'leader') fail('Only the Leader defines member responsibilities.'); member(team, call.target).responsibility = call.responsibility; }
      if (call.action === 'report') { self.summary = call.summary; self.updatedAt = now; }
      touch(team, now); return team;
    });
  }
  private resourceAccess(team: Team, memberId: string, resourceId: string): TeamResource {
    const upload = team.resourceUploads?.find(item => item.resource.resourceId === resourceId);
    const referenced=team.messages.some(message=>message.resources?.some(resource=>resource.resourceId===resourceId));
    if (!upload || !referenced && upload.expiresAt <= this.ports.now() || upload.ownerMemberId !== memberId && !team.messages.some(message => message.to === memberId && message.resources?.some(resource => resource.resourceId === resourceId))) fail('Resource access is not granted to this member.');
    return upload!.resource;
  }
  private pruneResourceUploads(team:Team) {
    if(!team.resourceUploads)return;
    const referenced=new Set(team.messages.flatMap(message=>message.resources?.map(resource=>resource.resourceId)??[]));
    team.resourceUploads=team.resourceUploads.filter(upload=>upload.expiresAt>this.ports.now()||referenced.has(upload.resource.resourceId));
  }
  private async prepareResources(hostId:string,call:Extract<TeamHostCall,{action:'send'}>,assertCurrent:()=>void) {
    const check=()=>{
      assertCurrent();const team=find(this.ports.read(),call.teamId),self=member(team,call.memberId),target=member(team,call.to);active(team);
      if(self.hostId!==hostId||self.creation!=='ready')fail('This Host is not the registered Team member.');
      if(target.id===self.id||self.role!=='leader'&&target.role!=='leader')fail('Members can communicate only with their Leader.');
      if(target.creation!=='ready')fail('Target member is not registered.');
      const id=createHash('sha256').update(JSON.stringify([self.id,call.operationId])).digest('hex');
      const existing=team.messages.find(message=>message.id===id);
      if(existing){if(existing.to!==call.to||existing.text!==call.text||JSON.stringify(existing.resources?.map(resource=>resource.resourceId))!==JSON.stringify(call.resources))fail('Message identity has different input.');return {team,existing};}
      if(team.messages.length>=200||teamMessageBudgetBytes(team)+Buffer.byteLength(call.text)>128*1024)fail('Team communication capacity reached.');
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
      await this.ports.change(teams=>{assertCurrent();const current=find(teams,team.id);this.pruneResourceUploads(current);const existing=current.resourceUploads?.find(item=>item.resource.resourceId===result.resource?.resourceId);if(existing)existing.expiresAt=this.ports.now()+(this.ports.resourceDraftTtlMs??86400000);});return result;
    }
    if (call.action === 'resource_chunk') {const result=await store.chunk(scope,{uploadId,offset:call.offset,contentBase64:call.contentBase64});authorize();return result;}
    const result = await store.finish(scope,uploadId);
    if (!result.resource) fail('Resource upload is incomplete.');
    return this.ports.change(teams => {
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
    return this.ports.change(teams => {
      const current = find(teams, teamId), slot = member(current, memberId);
      if (result.creation === 'ready' && teams.some(other => other.members.some(candidate => candidate !== slot && candidate.creation === 'ready' && candidate.hostId === result.hostId && candidate.providerId === result.providerId && candidate.nativeSessionId === result.nativeSessionId))) fail('Native session is already bound to a Team member.');
      const registering = slot.creation !== 'ready' && slot.creation !== 'abandoned' && result.creation === 'ready';
      if (slot.creation !== 'abandoned') Object.assign(slot, result);
      if (registering && result.role === 'member' && current.status === 'active') {
        const leader = current.members[0]!;
        if (current.messages.length >= 200) fail('Team communication capacity reached before registration.');
        current.messages.push({ id: createHash('sha256').update(JSON.stringify(['registration', result.id])).digest('hex'), from: result.id, to: leader.id,
          text: `Team member registered: ${result.name}. Host: ${result.hostId}. Provider: ${result.providerId}. Working directory: ${result.cwd || 'Host default'}. Responsibility: ${result.responsibility || 'Not defined yet; discuss with the user before assigning work.'}`, status: 'queued', createdAt: this.ports.now() });
      }
      // An archive may have started while native creation was in progress. Never reactivate it.
      if (current.status === 'active') touch(current, this.ports.now());
      if (!isTeam(current)) fail('Invalid Team state.'); return current;
    });
  }
}
