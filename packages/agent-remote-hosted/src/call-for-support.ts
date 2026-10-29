import { createHash, randomUUID } from 'node:crypto';
import { CALL_FOR_SUPPORT_CALL_LIMIT, nativeSessionRefKey, type CallForSupportCall, type CallForSupportCallInput, type CallForSupportGroup, type CallForSupportProfile,
  type Team, type TeamHostCall, type TeamMember, type TeamSource } from '@orchardworks/agent-remote-protocol';
import { assertTeamQueueCapacity, type SavedTeam } from './team-delivery.js';
import { effectiveProfiles, type CallForSupportState } from './call-for-support-profiles.js';
import type { TeamBrokerPorts } from './teams.js';

/** What the Team broker lends Call For Support groups. */
export interface CallForSupportBrokerPorts {
  ports: TeamBrokerPorts;
  change<T>(update: (teams: SavedTeam[]) => T): Promise<T>;
  provision(teamId: string, memberId: string): Promise<Team>;
  project(team: SavedTeam): Team;
}
/** The account and Host facts groups depend on. */
export interface CallForSupportPorts {
  state(): CallForSupportState | undefined;
  /** Throws unless the Host runs Call For Support groups. */
  assertHost(hostId: string): void;
  /** The provider enforces read-only sessions on the Host. */
  readOnly(hostId: string, providerId: string): boolean;
}
type WorkerCall = Extract<TeamHostCall, { action: 'call_for_support' }>;
type CallResult = { status: 'accepted' | 'needs_approval' | 'unavailable'; message: string; callId?: string; roleId?: string };
interface GroupCall extends CallForSupportCallInput { id: string; followUpOf?: string; origin: CallForSupportCall['origin'] }

export const CALL_FOR_SUPPORT_TEAM_LIMIT = 128;
const WAITING_CALL_LIMIT = 8;
const fail = (message: string): never => { throw new Error(message); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const callForSupportCallId = (teamId: string, operationId: string) => digest(['call', teamId, operationId]);
export const requester = (team: Team): TeamMember => team.members.find(member => member.role === 'requester') ?? fail('Support group has no worker.');
const group = (team: Team): CallForSupportGroup => team.callForSupport ?? fail('Team is not a support group.');
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The coordinator's view of one call; the call record stays readable with read_team. */
export function callMessageText(team: Team, call: CallForSupportCall): string {
  const context = call.context;
  const lines = [`[Support call ${call.id} · ${group(team).role} · ${call.deliverable} · from the ${call.origin === 'worker' ? 'worker' : 'user'}]`];
  if (call.followUpOf) lines.push(`Follow-up of call ${call.followUpOf}. Continue from your ledger.`);
  lines.push('Task:', call.task);
  const facts = [context?.commit && `commit ${context.commit}`, context?.base && `base ${context.base}`].filter(Boolean).join(', ');
  if (facts) lines.push(`Code: ${facts}.`);
  if (context?.files?.length) lines.push(clip(`Files: ${context.files.join(', ')}`, 2000));
  lines.push(context?.conversation ? 'You may read the worker\'s conversation with read_source_session.' : 'The worker did not share its conversation; do not read it.');
  lines.push(`Answer with report_support for call ${call.id}.`);
  return lines.join('\n');
}

/** Adds a call to a group. Calls are handled one at a time; later calls wait behind the open one. */
export function addCall(team: SavedTeam, input: GroupCall, now: number): CallForSupportCall {
  const support = group(team);
  const existing = support.calls.find(call => call.id === input.id);
  if (existing) {
    if (existing.task !== input.task || existing.deliverable !== input.deliverable || JSON.stringify(existing.context) !== JSON.stringify(input.context)) fail('Call identity has different input.');
    return existing;
  }
  if (team.status !== 'active') fail('The support group is archived.');
  if (support.status === 'paused_budget') fail(`Support is paused: ${support.pauseReason ?? 'its budget is reached'}.`);
  if (input.followUpOf && !support.calls.some(call => call.id === input.followUpOf)) fail('The call to follow up is unknown.');
  if (support.calls.filter(call => call.status === 'open' || call.status === 'queued').length >= WAITING_CALL_LIMIT) fail('Too many calls are waiting. Wait for a report first.');
  const open = !support.calls.some(call => call.status === 'open');
  const call: CallForSupportCall = { id: input.id, task: input.task, ...(input.context ? { context: structuredClone(input.context) } : {}), deliverable: input.deliverable,
    ...(input.followUpOf ? { followUpOf: input.followUpOf } : {}), origin: input.origin, status: open ? 'open' : 'queued', createdAt: now, usage: { tokens: 0 } };
  support.calls.push(call);
  while (support.calls.length > CALL_FOR_SUPPORT_CALL_LIMIT) {
    const index = support.calls.findIndex(item => item.status !== 'open' && item.status !== 'queued');
    if (index < 0) break;
    support.calls.splice(index, 1);
  }
  if (open) queueCall(team, call, now);
  return call;
}

/** Queues the open call's message from the worker's seat to the coordinator. */
export function queueCall(team: SavedTeam, call: CallForSupportCall, now: number): void {
  const message = { id: digest(['call-message', team.id, call.id]), from: requester(team).id, to: team.members[0]!.id, text: callMessageText(team, call),
    status: 'queued' as const, createdAt: now, callForSupportCallId: call.id };
  assertTeamQueueCapacity(team, message);
  team.messages.push(message);
}

/** The worker's active group for a profile: the group whose worker seat holds the worker's role now. */
export function workerGroup(teams: SavedTeam[], resolve: TeamBrokerPorts['resolveSession'], hostId: string, worker: { providerId: string; nativeSessionId: string }, select: (team: SavedTeam) => boolean): SavedTeam | undefined {
  let target: string;
  try { target = nativeSessionRefKey(resolve(hostId, worker.providerId, worker.nativeSessionId)); } catch { return undefined; }
  return teams.find(team => {
    if (!team.callForSupport || team.status === 'archived' || !select(team)) return false;
    const seat = team.members.find(member => member.role === 'requester');
    if (!seat?.nativeSessionId || seat.hostId !== hostId) return false;
    try { return nativeSessionRefKey(resolve(seat.hostId, seat.providerId, seat.nativeSessionId)) === target; } catch { return false; }
  });
}

/** A new group for a worker: the coordinator as Leader, then the worker's seat, then the first call. */
export function newGroup(input: { operationId: string; source: TeamSource; profile: CallForSupportProfile; coordinatorProviderId: string }, now: number): SavedTeam {
  const { profile, source } = input;
  const coordinator: TeamMember = { id: randomUUID(), role: 'leader', hostId: source.hostId, providerId: input.coordinatorProviderId, name: 'Coordinator',
    responsibility: `Coordinate support for the role "${profile.name}". Organize supporters within the mandate, merge their results and report to the worker.`,
    creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now, ...(profile.coordinator.model ? { model: profile.coordinator.model } : {}),
    ...(profile.coordinator.reasoningEffort ? { reasoningEffort: profile.coordinator.reasoningEffort } : {}), access: 'read_only', workspace: { kind: 'shared' } };
  const worker: TeamMember = { id: randomUUID(), role: 'requester', hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.nativeSessionId,
    name: 'Worker', responsibility: 'The session that called for support. It owns its task and workspace.', creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now };
  return { id: randomUUID(), operationId: input.operationId, revision: 1, source: structuredClone(source), title: clip(profile.name, 256), status: 'active',
    members: [coordinator, worker], messages: [], createdAt: now, updatedAt: now,
    callForSupport: { profileId: profile.id, profileRevision: profile.revision, role: clip(profile.name, 256), description: profile.description,
      mandate: structuredClone(profile.mandate), coordinator: { providerId: input.coordinatorProviderId, ...(profile.coordinator.model ? { model: profile.coordinator.model } : {}),
        ...(profile.coordinator.reasoningEffort ? { reasoningEffort: profile.coordinator.reasoningEffort } : {}) },
      status: 'active', calls: [], ledger: { text: '', revision: 0 }, usage: { tokens: 0 } } };
}

/** Group creation, calls and the worker's own requests, on top of the Team broker. */
export class CallForSupportGroups {
  constructor(private readonly broker: CallForSupportBrokerPorts, private readonly ports: CallForSupportPorts) {}
  private profile(id: string): CallForSupportProfile {
    return this.ports.state()?.profiles.find(profile => profile.id === id) ?? fail('Support profile not found.');
  }
  /** Creates a group, or adds the call to the worker's active group for the profile unless fresh. */
  async call(input: { operationId: string; source: TeamSource; profileId: string; call: CallForSupportCallInput & { followUpOf?: string }; origin: CallForSupportCall['origin']; fresh?: boolean }): Promise<{ team: Team; call: CallForSupportCall }> {
    const profile = this.profile(input.profileId);
    this.ports.assertHost(input.source.hostId);
    const coordinatorProviderId = profile.coordinator.providerId ?? input.source.providerId;
    this.broker.ports.assertHost(input.source.hostId, coordinatorProviderId);
    if (!this.ports.readOnly(input.source.hostId, coordinatorProviderId)) fail('The coordinator\'s provider cannot run read-only sessions on the worker\'s Host.');
    const result = await this.broker.change(teams => {
      const now = this.broker.ports.now();
      const created = teams.find(team => team.operationId === input.operationId);
      if (created) {
        if (!created.callForSupport || JSON.stringify(created.source) !== JSON.stringify(input.source) || created.callForSupport.profileId !== profile.id) fail('Creation identity has different input.');
        return { team: created, call: addCall(created, { ...input.call, id: callForSupportCallId(created.id, input.operationId), origin: input.origin }, now), created: true };
      }
      const current = workerGroup(teams, this.broker.ports.resolveSession, input.source.hostId, input.source, team => team.callForSupport?.profileId === profile.id);
      if (current && !input.fresh) return { team: current, call: addCall(current, { ...input.call, id: callForSupportCallId(current.id, input.operationId), origin: input.origin }, now), created: false };
      if (current) { current.status = 'archiving'; for (const message of current.messages) if (message.status === 'queued') message.status = 'canceled'; current.revision++; current.updatedAt = now; }
      if (teams.length >= CALL_FOR_SUPPORT_TEAM_LIMIT) fail('Team capacity reached.');
      const team = newGroup({ operationId: input.operationId, source: input.source, profile, coordinatorProviderId }, now);
      teams.push(team);
      return { team, call: addCall(team, { ...input.call, id: callForSupportCallId(team.id, input.operationId), origin: input.origin }, now), created: true };
    });
    if (!result.created) return { team: this.broker.project(result.team), call: result.call };
    return { team: await this.provision(result.team.id), call: result.call };
  }
  /** The worker's seat binds first and reports its directory; the coordinator starts there. */
  async provision(teamId: string): Promise<Team> {
    const saved = this.broker.ports.read().find(team => team.id === teamId) ?? fail('Team not found.');
    const seat = requester(saved);
    let team = await this.broker.provision(teamId, seat.id);
    if (requester(team).creation !== 'ready') return team;
    const cwd = requester(team).cwd;
    if (cwd && !team.members[0]!.cwd) await this.broker.change(teams => { const current = teams.find(item => item.id === teamId)!; if (!current.members[0]!.cwd) current.members[0]!.cwd = cwd; });
    team = await this.broker.provision(teamId, team.members[0]!.id);
    return team;
  }
  /** A call from the user on an existing group. */
  async userCall(teamId: string, input: CallForSupportCallInput & { operationId: string; followUpOf?: string }): Promise<Team> {
    const team = await this.broker.change(teams => {
      const current = teams.find(item => item.id === teamId) ?? fail('Team not found.');
      group(current);
      addCall(current, { task: input.task, ...(input.context ? { context: input.context } : {}), deliverable: input.deliverable, ...(input.followUpOf ? { followUpOf: input.followUpOf } : {}),
        id: callForSupportCallId(current.id, input.operationId), origin: 'user' }, this.broker.ports.now());
      return current;
    });
    return this.broker.project(team);
  }
  /** The worker's own tool calls, made by its Controller on its behalf. */
  async workerCall(hostId: string, call: WorkerCall | Extract<TeamHostCall, { action: 'support_status' }>): Promise<unknown> {
    this.ports.assertHost(hostId);
    const worker = { hostId, providerId: call.worker.providerId, nativeSessionId: call.worker.nativeSessionId };
    const profiles = effectiveProfiles(this.ports.state(), (host, provider, native) => this.broker.ports.resolveSession(host, provider, native), worker);
    const teams = this.broker.ports.read();
    if (call.action === 'support_status') return this.status(teams, worker, profiles, call);
    const unavailable = (message: string): CallResult => ({ status: 'unavailable', message });
    if (!profiles.length) return unavailable('Call For Support is not enabled for this session. The user can enable it in the session actions of the website.');
    const input = { task: call.task, ...(call.context ? { context: call.context } : {}), deliverable: call.deliverable, ...(call.followUpOf ? { followUpOf: call.followUpOf } : {}) };
    if (call.roleId) {
      const target = workerGroup(teams, this.broker.ports.resolveSession, hostId, worker, team => team.id === call.roleId);
      if (!target) return unavailable('This session has no support role with that roleId. Read support_status for its roles.');
      if (target.callForSupport!.profileId && !profiles.some(profile => profile.id === target.callForSupport!.profileId)) return unavailable('This support role is no longer enabled for this session.');
      if (target.status !== 'active') return unavailable('This support role is archived. Call with its profileId to start a new one.');
      if (target.callForSupport!.status === 'paused_budget') return unavailable(`This support role is paused: ${target.callForSupport!.pauseReason ?? 'its budget is reached'}. The user can raise the budget and resume it.`);
      const result = await this.broker.change(saved => {
        const current = saved.find(item => item.id === target.id)!;
        return addCall(current, { ...input, id: callForSupportCallId(current.id, call.operationId), origin: 'worker' }, this.broker.ports.now());
      });
      return accepted(target.id, result);
    }
    if (!call.profileId) return { status: 'needs_approval', message: 'Choose a profileId from support_status, or ask the user to call for support from the website.' } satisfies CallResult;
    if (!profiles.some(profile => profile.id === call.profileId)) return unavailable('This support profile is not enabled for this session. Read support_status for the enabled profiles.');
    const result = await this.call({ operationId: call.operationId, source: { ...worker, title: call.worker.title ?? 'Worker session' }, profileId: call.profileId, call: input, origin: 'worker', ...(call.fresh ? { fresh: true } : {}) });
    return accepted(result.team.id, result.call);
  }
  private status(teams: SavedTeam[], worker: { hostId: string; providerId: string; nativeSessionId: string }, profiles: CallForSupportProfile[], call: Extract<TeamHostCall, { action: 'support_status' }>) {
    const groups: SavedTeam[] = [];
    for (const team of teams) if (workerGroup([team], this.broker.ports.resolveSession, worker.hostId, worker, item => !call.roleId || item.id === call.roleId)) groups.push(team);
    if (call.callId) {
      const owner = groups.find(team => team.callForSupport!.calls.some(item => item.id === call.callId));
      const found = owner?.callForSupport!.calls.find(item => item.id === call.callId);
      return found ? { roleId: owner!.id, requesterMemberId: requester(owner!).id, call: structuredClone(found) } : fail('Support call not found for this session.');
    }
    return { enabled: profiles.length > 0, profiles: profiles.map(({ id, name, description }) => ({ id, name, description })),
      roles: groups.map(team => {
        const support = team.callForSupport!, reported = support.calls.filter(item => item.report).at(-1);
        return { roleId: team.id, role: support.role, status: team.status === 'active' ? support.status : team.status, requesterMemberId: requester(team).id,
          calls: support.calls.filter(item => item.status === 'open' || item.status === 'queued').map(item => ({ id: item.id, status: item.status, task: clip(item.task, 200) })),
          ...(reported ? { lastReport: { callId: reported.id, status: reported.report!.status, summary: reported.report!.summary } } : {}) };
      }) };
  }
}

function accepted(roleId: string, call: CallForSupportCall): CallResult {
  return { status: 'accepted', callId: call.id, roleId, message: call.status === 'queued'
    ? 'Accepted. It waits behind the open call of this role. Its report will arrive as input; keep working meanwhile.'
    : 'Accepted. The report will arrive as input; keep working meanwhile. Follow up on the same roleId to keep the supporters\' context.' };
}
