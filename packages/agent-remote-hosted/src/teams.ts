import { createHash, randomUUID } from 'node:crypto';
import { isTeam, isTeamMember, type Team, type TeamAction, type TeamCreate, type TeamHostCall, type TeamMember, type TeamSeat } from '@orchardworks/agent-remote-protocol';

export interface TeamBrokerPorts {
  read(): Team[];
  change<T>(update: (teams: Team[]) => T): Promise<T>;
  createSeat(hostId: string, seat: TeamSeat): Promise<TeamMember>;
  assertHost(hostId: string, providerId: string): void;
  now(): number;
}
const fail = (message: string): never => { throw new Error(message); };
const find = (teams: Team[], id: string) => teams.find(team => team.id === id) ?? fail('Team not found.');
const member = (team: Team, id: string) => team.members.find(item => item.id === id) ?? fail('Team member not found.');
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
        const id = createHash('sha256').update(JSON.stringify([self.id, call.operationId])).digest('hex');
        const existing = team.messages.find(message => message.id === id);
        if (existing) { if (existing.to !== call.to || existing.text !== call.text) fail('Message identity has different input.'); return existing; }
        if (team.messages.length >= 200 || Buffer.byteLength(JSON.stringify(team.messages)) + Buffer.byteLength(call.text) > 128 * 1024) fail('Team communication capacity reached.');
        const message = { id, from: self.id, to: call.to, text: call.text, status: 'queued' as const, createdAt: now }; team.messages.push(message); touch(team, now); return message;
      }
      if (call.action === 'describe_member') { if (self.role !== 'leader') fail('Only the Leader defines member responsibilities.'); member(team, call.target).responsibility = call.responsibility; }
      if (call.action === 'report') { self.summary = call.summary; self.updatedAt = now; }
      touch(team, now); return team;
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
