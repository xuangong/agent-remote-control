import { createHash, randomUUID } from 'node:crypto';
import { CALL_FOR_SUPPORT_CALL_LIMIT, CALL_FOR_SUPPORT_GROUP_BYTES, CALL_FOR_SUPPORT_REPORT_BYTES, callForSupportReportBytes, isTeamResource, nativeSessionRefKey, type CallForSupportCall,
  type CallForSupportCallInput, type CallForSupportGroup, type CallForSupportProfile, type CallForSupportReport, type CallForSupportRoster, type CallForSupportRosterMember, type Team,
  type TeamAction, type TeamHostCall, type TeamMember, type TeamResource, type TeamSource } from '@orchardworks/agent-remote-protocol';
import { assertTeamQueueCapacity, type SavedTeam } from './team-delivery.js';
import { effectiveProfiles, type CallForSupportState } from './call-for-support-profiles.js';
import type { TeamBrokerPorts } from './teams.js';

/** What the Team broker lends Call For Support groups. */
export interface CallForSupportBrokerPorts {
  ports: TeamBrokerPorts;
  change<T>(update: (teams: SavedTeam[]) => T): Promise<T>;
  provision(teamId: string, memberId: string): Promise<Team>;
  project(team: SavedTeam): Team;
  /** A resource the member may attach, or a failure. */
  resource(team: SavedTeam, memberId: string, resourceId: string): TeamResource;
  /** Verifies stored bytes; keep pins them for as long as their Team exists. */
  pinResources(teamId: string, memberId: string, resourceIds: string[], keep?: boolean): Promise<void>;
}
/** The account and Host facts groups depend on. */
export interface CallForSupportPorts {
  state(): CallForSupportState | undefined;
  /** The Host runs Call For Support groups; others never see them. */
  capable(hostId: string): boolean;
  /** Throws unless the Host runs Call For Support groups. */
  assertHost(hostId: string): void;
  /** The provider enforces read-only sessions on the Host. */
  readOnly(hostId: string, providerId: string): boolean;
  /** Asks the worker's Host to upload a bundle of the commit as the worker's seat. */
  supportBundle(hostId: string, input: { teamId: string; memberId: string; commit: string; base?: string; operationId: string }): Promise<unknown>;
  /** Asks a supporter's Host to upload the patch of its worktree as the supporter; { empty: true } when it changed nothing. */
  supportPatch(hostId: string, input: { teamId: string; memberId: string; operationId: string }): Promise<unknown>;
}
type WorkerCall = Extract<TeamHostCall, { action: 'call_for_support' }>;
type CallResult = { status: 'accepted' | 'needs_approval' | 'unavailable'; message: string; callId?: string; roleId?: string };
interface GroupCall extends CallForSupportCallInput { id: string; followUpOf?: string; origin: CallForSupportCall['origin'] }

export const CALL_FOR_SUPPORT_TEAM_LIMIT = 128;
/** Archived groups are removed above this size of the account's Team state, which may not exceed 2 MiB, so active Teams keep room to grow. */
export const CALL_FOR_SUPPORT_RETENTION_BYTES = 1536 * 1024;
const TEAM_MEMBER_LIMIT = 12;
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

/** Supporters that count toward the mandate: not released or abandoned. */
export const activeSupporters = (team: Team) => team.members.filter(member => member.role === 'member' && member.creation !== 'released' && member.creation !== 'abandoned');
const sameConfiguration = (a: { providerId: string; model: string; reasoningEffort?: string }, b: typeof a) => a.providerId === b.providerId && a.model === b.model && a.reasoningEffort === b.reasoningEffort;

/** Stops delivering to a supporter. Its session is kept for history. */
export function releaseSupporter(team: SavedTeam, memberId: string, now: number): void {
  const target = team.members.find(member => member.id === memberId) ?? fail('Team member not found.');
  if (target.role !== 'member') fail('Only supporters can be released.');
  if (target.creation === 'released') return;
  if (target.creation === 'abandoned') fail('The supporter was abandoned.');
  target.creation = 'released'; target.activity = 'idle'; target.updatedAt = now;
  for (const message of team.messages) if (message.to === memberId && message.status === 'queued') message.status = 'canceled';
}

/** A note to the coordinator from the worker's seat, which every Team message needs as sender. */
function noteToCoordinator(team: SavedTeam, id: string, text: string, now: number): void {
  if (team.messages.some(message => message.id === id)) return;
  const message = { id, from: requester(team).id, to: team.members[0]!.id, text: `[Call For Support] ${text}`, status: 'queued' as const, createdAt: now };
  assertTeamQueueCapacity(team, message);
  team.messages.push(message);
}

const FINDINGS_TEXT = 9000;
/** The worker's view of a report: advice, labeled with its call and role, with details on demand. */
export function reportMessageText(team: Team, call: CallForSupportCall, report: CallForSupportReport): string {
  const lines = [`[Support report · ${group(team).role} · call ${call.id} · ${report.status}]`, report.summary];
  let budget = FINDINGS_TEXT, shown = 0;
  for (const finding of report.findings) {
    const line = clip(`- [${finding.severity}] ${finding.location ? `${finding.location}: ` : ''}${finding.problem}${finding.suggestion ? ` → ${finding.suggestion}` : ''}${finding.agreement ? ` (${finding.agreement})` : ''}`, 1500);
    if (line.length > budget) break;
    if (!shown) lines.push('Findings:');
    lines.push(line); budget -= line.length; shown++;
  }
  if (shown < report.findings.length) lines.push(`${report.findings.length - shown} more findings. Read the full report with read_support_report.`);
  for (const resource of report.resources ?? []) lines.push(`Resource ${resource.resourceId}: ${resource.name} (${resource.mediaType}, ${resource.byteLength} bytes).`);
  lines.push(`This report is advice. You own the decision and your workspace: adopt what convinces you and verify it before relying on it. Read details and evidence with read_support_report for call ${call.id}${report.resources?.length ? ', download resources with download_support_resource; never run or apply them unread' : ''}. Follow up with call_for_support on roleId ${team.id}.`);
  return lines.join('\n');
}

/** Records a report on a call, delivers it to the worker and opens the next waiting call. */
function settleCall(team: SavedTeam, call: CallForSupportCall, report: CallForSupportReport, now: number): void {
  call.report = report; call.status = report.status; call.reportedAt = now;
  const message = { id: digest(['report', team.id, call.id]), from: team.members[0]!.id, to: requester(team).id, text: reportMessageText(team, call, report),
    ...(report.resources?.length ? { resources: structuredClone(report.resources) } : {}), status: 'queued' as const, createdAt: now, callForSupportCallId: call.id };
  assertTeamQueueCapacity(team, message);
  team.messages.push(message);
  openNextCall(team, now);
}
function openNextCall(team: SavedTeam, now: number): void {
  const support = group(team);
  if (support.status !== 'active' || team.status !== 'active' || support.calls.some(call => call.status === 'open')) return;
  const next = support.calls.find(call => call.status === 'queued');
  if (next) { next.status = 'open'; queueCall(team, next, now); }
}

/** Why the group must pause for its budget, if it must. */
export function budgetReason(support: CallForSupportGroup): string | undefined {
  const budget = support.mandate.budget, open = support.calls.find(call => call.status === 'open');
  if (!budget) return undefined;
  if (budget.tokensPerCall && open && open.usage.tokens >= budget.tokensPerCall) return `Call ${open.id} used ${open.usage.tokens} tokens of its ${budget.tokensPerCall}-token budget.`;
  if (budget.tokensTotal && support.usage.tokens >= budget.tokensTotal) return `This role used ${support.usage.tokens} tokens of its ${budget.tokensTotal}-token budget.`;
  if (budget.costUsdTotal && (support.usage.costUsd ?? 0) >= budget.costUsdTotal) return `This role cost $${(support.usage.costUsd ?? 0).toFixed(2)} of its $${budget.costUsdTotal} budget.`;
  return undefined;
}
function pauseForBudget(team: SavedTeam, reason: string, now: number): void {
  const support = group(team);
  support.status = 'paused_budget'; support.pauseReason = clip(reason, 2048);
  const open = support.calls.find(call => call.status === 'open');
  if (open) settleCall(team, open, { status: 'needs_input', summary: `Support paused: ${reason} The user can raise the budget and resume this role.`, findings: [] }, now);
}

const groupBytes = (support: CallForSupportGroup) => Buffer.byteLength(JSON.stringify(support));
/** Keeps a group within its storage bound: evidence of older reports first, then their findings, then the oldest reported calls. */
export function compactCallForSupport(team: SavedTeam): void {
  const support = team.callForSupport;
  if (!support || groupBytes(support) <= CALL_FOR_SUPPORT_GROUP_BYTES) return;
  const reported = () => support.calls.filter(call => call.report);
  const latest = reported().at(-1);
  for (const call of reported()) if (call !== latest) for (const finding of call.report!.findings) if (finding.evidence !== undefined) { delete finding.evidence; call.report!.compacted = true; }
  for (const call of reported()) {
    if (groupBytes(support) <= CALL_FOR_SUPPORT_GROUP_BYTES) return;
    if (call !== latest && call.report!.findings.length) { call.report!.findings = []; call.report!.compacted = true; }
  }
  while (groupBytes(support) > CALL_FOR_SUPPORT_GROUP_BYTES) {
    const index = support.calls.findIndex(call => call.report && call !== latest);
    if (index < 0) break;
    support.calls.splice(index, 1);
  }
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

const oldestArchivedGroup = (teams: SavedTeam[]) => teams.filter(team => team.callForSupport && team.status === 'archived')
  .reduce<SavedTeam | undefined>((found, team) => !found || team.updatedAt < found.updatedAt ? team : found, undefined);

/**
 * Makes room for one more Team. At the Team limit the oldest archived support group is removed: groups are created automatically
 * and nothing else would remove them. Ordinary Teams are never removed.
 */
export function admitTeam(teams: SavedTeam[]): void {
  if (teams.length < CALL_FOR_SUPPORT_TEAM_LIMIT) return;
  const oldest = oldestArchivedGroup(teams) ?? fail('Team capacity reached.');
  teams.splice(teams.indexOf(oldest), 1);
}

/** Removes the oldest archived support groups while the Team state is larger than the retention bound. */
export function pruneArchivedGroups(teams: SavedTeam[]): void {
  for (let oldest = oldestArchivedGroup(teams); oldest && Buffer.byteLength(JSON.stringify(teams)) > CALL_FOR_SUPPORT_RETENTION_BYTES; oldest = oldestArchivedGroup(teams)) {
    teams.splice(teams.indexOf(oldest), 1);
  }
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
      admitTeam(teams);
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
  /** Checks a roster against the Hosts and the mandate. Problems no approval can fix throw; the rest only leave the mandate. */
  private assessRoster(team: SavedTeam, proposal: { members: CallForSupportRosterMember[]; release?: string[] }): boolean {
    const support = group(team), open = support.calls.find(call => call.status === 'open');
    for (const id of proposal.release ?? []) {
      const target = team.members.find(member => member.id === id);
      if (!target || target.role !== 'member' || target.creation === 'released' || target.creation === 'abandoned') fail(`Cannot release ${id}: it is not an active supporter.`);
    }
    if (team.members.length + proposal.members.length > TEAM_MEMBER_LIMIT) fail('The group has no room for more members. Archive it and call again with fresh.');
    let within = true;
    for (const member of proposal.members) {
      const hostId = member.workspace === 'remote' ? member.hostId! : team.source.hostId;
      this.ports.assertHost(hostId);
      this.broker.ports.assertHost(hostId, member.providerId);
      if (member.workspace === 'shared' && !this.ports.readOnly(hostId, member.providerId)) fail(`${member.providerId} cannot run read-only sessions on the worker's Host; use a worktree.`);
      if (member.workspace === 'remote' && !support.mandate.remoteHosts.some(host => host.hostId === member.hostId)) fail('Remote supporters need a Host and repository from the mandate.');
      if (member.workspace !== 'shared' && !open?.context?.commit) fail('Worktree and remote supporters start at the call\'s commit. Report needs_input and ask the worker to commit and call again.');
      if (!support.mandate.supporters.some(allowed => sameConfiguration(allowed, member)) || !support.mandate.workspaces.includes(member.workspace)) within = false;
    }
    const released = new Set(proposal.release ?? []);
    if (activeSupporters(team).filter(member => !released.has(member.id)).length + proposal.members.length > support.mandate.maxSupporters) within = false;
    return within;
  }
  /** Requests from the group's sessions: the coordinator's, and every member's usage. */
  async memberCall(hostId: string, call: Extract<TeamHostCall, { action: 'propose_roster' | 'release_supporter' | 'report_support' | 'write_ledger' | 'report_usage' | 'collect_supporter_patch' }>): Promise<unknown> {
    this.ports.assertHost(hostId);
    if (call.action === 'propose_roster' || call.action === 'release_supporter') return this.rosterCall(hostId, call);
    if (call.action === 'collect_supporter_patch') return this.collectPatch(hostId, call);
    if (call.action === 'report_support' && call.report.resources?.length) {
      this.coordinator(structuredClone(this.broker.ports.read().find(team => team.id === call.teamId) ?? fail('Team not found.')), hostId, call.memberId);
      await this.broker.pinResources(call.teamId, call.memberId, call.report.resources);
    }
    return this.broker.change(teams => {
      const team = teams.find(item => item.id === call.teamId) ?? fail('Team not found.'), now = this.broker.ports.now(), support = group(team);
      if (call.action === 'report_usage') return this.usage(team, hostId, call, now);
      this.coordinator(team, hostId, call.memberId);
      if (team.status !== 'active') fail('Team is not active.');
      if (call.action === 'write_ledger') {
        if (call.revision !== support.ledger.revision) fail('The ledger changed. Read it with read_team, merge, and write again.');
        support.ledger = { text: call.text, revision: call.revision + 1 }; team.revision++; team.updatedAt = now;
        return { revision: support.ledger.revision };
      }
      const target = support.calls.find(item => item.id === call.callId) ?? fail('Support call not found.');
      const report: CallForSupportReport = { status: call.report.status, summary: call.report.summary, findings: structuredClone(call.report.findings),
        ...(call.report.resources?.length ? { resources: call.report.resources.map(id => this.broker.resource(team, call.memberId, id)) } : {}) };
      if (target.report) {
        const { compacted: _compacted, ...stored } = target.report;
        if (JSON.stringify(stored) === JSON.stringify(report)) return { callId: target.id, status: target.status };
        fail('This call was already reported. Answer follow-up calls instead.');
      }
      if (target.status !== 'open') fail('Report the open call first; this call is waiting behind it.');
      if (new Set(report.findings.map(finding => finding.id)).size !== report.findings.length) fail('Finding IDs must be unique.');
      if (callForSupportReportBytes(report) > CALL_FOR_SUPPORT_REPORT_BYTES) fail('The report is too large. Keep evidence short and attach long material as a resource.');
      settleCall(team, target, report, now); team.revision++; team.updatedAt = now;
      return { callId: target.id, status: target.status };
    });
  }
  private coordinator(team: SavedTeam, hostId: string, memberId: string): TeamMember {
    const self = team.members.find(member => member.id === memberId) ?? fail('Team member not found.');
    if (self.hostId !== hostId || self.creation !== 'ready') fail('This Host is not the registered Team member.');
    if (self.role !== 'leader') fail('Only the coordinator does this.');
    return self;
  }
  /** Cumulative usage of a coordinator or supporter session; increases count toward the open call and the role. */
  private usage(team: SavedTeam, hostId: string, call: Extract<TeamHostCall, { action: 'report_usage' }>, now: number) {
    const support = group(team), self = team.members.find(member => member.id === call.memberId) ?? fail('Team member not found.');
    if (self.hostId !== hostId || self.creation !== 'ready' && self.creation !== 'released') fail('This Host is not the registered Team member.');
    if (self.role === 'requester') fail('The worker\'s own usage is not support usage.');
    const previous: { tokens: number; costUsd?: number } = self.usage ?? { tokens: 0 };
    if (call.tokens < previous.tokens || call.costUsd !== undefined && call.costUsd < (previous.costUsd ?? 0)) fail('Usage is cumulative and cannot decrease.');
    const tokens = call.tokens - previous.tokens, cost = call.costUsd === undefined ? 0 : call.costUsd - (previous.costUsd ?? 0);
    if (!tokens && !cost) return { tokens: support.usage.tokens, status: support.status };
    self.usage = { tokens: call.tokens, ...(call.costUsd !== undefined ? { costUsd: call.costUsd } : previous.costUsd !== undefined ? { costUsd: previous.costUsd } : {}), updatedAt: now };
    const add = (usage: { tokens: number; costUsd?: number }) => { usage.tokens += tokens; if (cost) usage.costUsd = (usage.costUsd ?? 0) + cost; };
    add(support.usage);
    const open = support.calls.find(item => item.status === 'open');
    if (open) add(open.usage);
    const reason = support.status === 'active' ? budgetReason(support) : undefined;
    if (reason) pauseForBudget(team, reason, now);
    team.revision++; team.updatedAt = now;
    return { tokens: support.usage.tokens, status: support.status };
  }
  /** The coordinator's roster requests. */
  private async rosterCall(hostId: string, call: Extract<TeamHostCall, { action: 'propose_roster' | 'release_supporter' }>): Promise<unknown> {
    const result = await this.broker.change(teams => {
      const team = teams.find(item => item.id === call.teamId) ?? fail('Team not found.'), now = this.broker.ports.now();
      const self = this.coordinator(team, hostId, call.memberId), support = group(team);
      if (team.status !== 'active') fail('Team is not active.');
      if (call.action === 'release_supporter') { releaseSupporter(team, call.target, now); team.revision++; team.updatedAt = now; return { team, provision: false }; }
      const id = digest(['roster', team.id, self.id, call.operationId]);
      if (support.roster?.id === id) return { team, provision: false };
      if (support.status === 'paused_budget') fail(`Support is paused: ${support.pauseReason ?? 'its budget is reached'}.`);
      const withinMandate = this.assessRoster(team, call);
      const automatic = withinMandate && support.mandate.approval === 'within_mandate';
      const roster: CallForSupportRoster = { id, status: automatic ? 'approved' : 'pending', members: structuredClone(call.members), ...(call.release?.length ? { release: [...call.release] } : {}),
        rationale: call.rationale, withinMandate, createdAt: now, ...(automatic ? { decidedAt: now } : {}) };
      support.roster = roster; team.revision++; team.updatedAt = now;
      return { team, provision: automatic };
    });
    if (call.action === 'release_supporter') return { released: call.target };
    const roster = result.team.callForSupport!.roster!;
    if (result.provision) await this.provisionRoster(result.team.id, roster.id);
    const current = this.broker.ports.read().find(team => team.id === result.team.id)!.callForSupport!.roster!;
    return { rosterId: current.id, status: current.status, withinMandate: current.withinMandate,
      message: current.status === 'pending' ? (current.withinMandate ? 'Waiting for the user to approve the roster.' : 'The roster is outside the mandate and waits for the user.')
        : current.status === 'provisioned' ? 'Provisioned. Each supporter sends a registration message when it is ready.' : `Roster ${current.status}.` };
  }
  /** Releases the roster's members, then adds and creates its new ones. */
  private async provisionRoster(teamId: string, rosterId: string): Promise<void> {
    const added = await this.broker.change(teams => {
      const team = teams.find(item => item.id === teamId) ?? fail('Team not found.'), now = this.broker.ports.now();
      const support = group(team), roster = support.roster;
      if (!roster || roster.id !== rosterId || roster.status !== 'approved') return [];
      this.assessRoster(team, roster);
      for (const id of roster.release ?? []) releaseSupporter(team, id, now);
      const worker = requester(team), commit = support.calls.find(call => call.status === 'open')?.context?.commit;
      const members = roster.members.map((member, index): TeamMember => {
        const remote = member.workspace === 'remote' ? support.mandate.remoteHosts.find(host => host.hostId === member.hostId)! : undefined;
        return { id: digest(['roster-member', rosterId, index]).slice(0, 32), hostId: remote?.hostId ?? team.source.hostId, providerId: member.providerId, role: 'member',
          name: member.name, responsibility: member.responsibility, ...(remote ? { cwd: remote.workspace } : worker.cwd ? { cwd: worker.cwd } : {}),
          model: member.model, ...(member.reasoningEffort ? { reasoningEffort: member.reasoningEffort } : {}),
          ...(member.workspace === 'shared' ? { access: 'read_only' as const, workspace: { kind: 'shared' as const } }
            : member.workspace === 'worktree' ? { workspace: { kind: 'worktree' as const, commit: commit! } } : { workspace: { kind: 'remote' as const, commit: commit!, repository: remote!.workspace } }),
          creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now };
      });
      for (const member of members) if (!team.members.some(item => item.id === member.id)) team.members.push(member);
      team.revision++; team.updatedAt = now;
      return members.map(member => member.id);
    });
    for (const memberId of added) {
      const member = this.broker.ports.read().find(team => team.id === teamId)?.members.find(item => item.id === memberId);
      if (member?.workspace?.kind === 'remote' && !member.workspace.bundle) {
        try { await this.attachBundle(teamId, memberId); }
        catch (error) {
          await this.broker.change(teams => { const target = teams.find(team => team.id === teamId)?.members.find(item => item.id === memberId);
            if (target?.creation === 'reserved') { target.creation = 'unknown'; target.error = (error instanceof Error ? error.message : 'The support bundle failed.').slice(0, 2048); } });
          continue;
        }
      }
      await this.broker.provision(teamId, memberId);
    }
    if (added.length) await this.broker.change(teams => {
      const team = teams.find(item => item.id === teamId)!, roster = team.callForSupport?.roster;
      if (roster?.id === rosterId && roster.status === 'approved') { roster.status = 'provisioned'; team.revision++; team.updatedAt = this.broker.ports.now(); }
    });
  }
  /** The patch of a supporter's own worktree, for the coordinator to review and attach to a report. */
  private async collectPatch(hostId: string, call: Extract<TeamHostCall, { action: 'collect_supporter_patch' }>): Promise<unknown> {
    const team = this.broker.ports.read().find(item => item.id === call.teamId) ?? fail('Team not found.');
    this.coordinator(structuredClone(team), hostId, call.memberId);
    if (team.status !== 'active') fail('Team is not active.');
    const target = team.members.find(member => member.id === call.target) ?? fail('Team member not found.');
    if (target.role !== 'member' || (target.workspace?.kind !== 'worktree' && target.workspace?.kind !== 'remote')) fail('Only supporters with their own worktree have a patch.');
    if (target.creation !== 'ready') fail('The supporter is not available; collect its patch before releasing it.');
    const result: unknown = await this.ports.supportPatch(target.hostId, { teamId: team.id, memberId: target.id, operationId: digest(['patch', team.id, call.memberId, call.operationId]) });
    if (result && typeof result === 'object' && 'empty' in result && result.empty === true) return { empty: true, message: 'The supporter changed nothing.' };
    if (!isTeamResource(result)) throw new Error('Invalid supporter patch.');
    // Kept only once a report attaches it; otherwise it expires like any unattached upload.
    await this.broker.pinResources(team.id, target.id, [result.resourceId], false);
    await this.broker.change(teams => {
      const current = teams.find(item => item.id === team.id) ?? fail('Team not found.');
      this.broker.resource(current, target.id, result.resourceId);
      const grants = current.resourceGrants ??= [];
      let grant = grants.find(item => item.resourceId === result.resourceId);
      if (!grant) { grant = { resourceId: result.resourceId, memberIds: [] }; grants.push(grant); }
      if (!grant.memberIds.includes(call.memberId)) grant.memberIds.push(call.memberId);
    });
    return { resource: result, message: 'Review the patch, then attach its resourceId to report_support if the worker should have it.' };
  }
  /** A remote supporter starts from a bundle of the call's commit that the worker's Host uploads; only that supporter may read it. */
  private async attachBundle(teamId: string, memberId: string): Promise<void> {
    const team = this.broker.ports.read().find(item => item.id === teamId) ?? fail('Team not found.'), worker = requester(team);
    const member = team.members.find(item => item.id === memberId)!, workspace = member.workspace as Extract<TeamMember['workspace'], { kind: 'remote' }>;
    const base = group(team).calls.find(call => call.status === 'open')?.context?.base;
    const resource = await this.ports.supportBundle(worker.hostId, { teamId, memberId: worker.id, commit: workspace.commit, ...(base ? { base } : {}), operationId: digest(['bundle', teamId, memberId]) });
    if (!isTeamResource(resource)) throw new Error('Invalid support bundle.');
    // Read once while the supporter is created, so it expires like any unattached upload instead of filling the account's storage.
    await this.broker.pinResources(teamId, worker.id, [resource.resourceId], false);
    await this.broker.change(teams => {
      const current = teams.find(item => item.id === teamId) ?? fail('Team not found.'), target = current.members.find(item => item.id === memberId) ?? fail('Team member not found.');
      this.broker.resource(current, worker.id, resource.resourceId);
      const grants = current.resourceGrants ??= [];
      let grant = grants.find(item => item.resourceId === resource.resourceId);
      if (!grant) { grant = { resourceId: resource.resourceId, memberIds: [] }; grants.push(grant); }
      if (!grant.memberIds.includes(memberId)) grant.memberIds.push(memberId);
      if (target.workspace?.kind === 'remote') target.workspace = { ...target.workspace, bundle: resource.resourceId };
    });
  }
  /** The user's decisions on a group. */
  async userAction(input: Extract<TeamAction, { action: 'resolve_roster' | 'release_member' | 'update_mandate' | 'resume_group' }>): Promise<Team> {
    const result = await this.broker.change(teams => {
      const team = teams.find(item => item.id === input.teamId) ?? fail('Team not found.'), now = this.broker.ports.now(), support = group(team);
      if (team.status !== 'active') fail('Team is not active.');
      if (input.action === 'update_mandate') {
        support.mandate = structuredClone(input.mandate);
        if (input.profileRevision !== undefined) support.profileRevision = input.profileRevision;
        team.revision++; team.updatedAt = now; return { team, provision: false };
      }
      if (input.action === 'resume_group') {
        if (support.status === 'active') return { team, provision: false };
        const reason = budgetReason(support);
        if (reason) fail(`Raise the budget before resuming: ${reason}`);
        support.status = 'active'; delete support.pauseReason;
        openNextCall(team, now); team.revision++; team.updatedAt = now; return { team, provision: false };
      }
      if (input.action === 'release_member') { releaseSupporter(team, input.memberId, now); team.revision++; team.updatedAt = now; return { team, provision: false }; }
      const roster = support.roster;
      if (!roster || roster.id !== input.rosterId) fail('Roster not found.');
      if (roster!.status !== 'pending') {
        // Approving again resumes a provisioning that stopped part way.
        if (roster!.status === 'approved' && input.decision === 'approve') return { team, provision: true };
        if (roster!.status === 'rejected' && input.decision === 'reject' || roster!.status === 'provisioned' && input.decision === 'approve') return { team, provision: false };
        fail('The roster was already decided.');
      }
      roster!.decidedAt = now; if (input.note) roster!.note = input.note;
      if (input.decision === 'reject') {
        roster!.status = 'rejected';
        noteToCoordinator(team, digest(['roster-decision', roster!.id]), `The user rejected roster ${roster!.id}.${input.note ? ` Note: ${input.note}` : ''} Propose another roster or report needs_input.`, now);
      } else {
        if (support.status === 'paused_budget') fail('Resume the group before approving a roster.');
        roster!.status = 'approved';
      }
      team.revision++; team.updatedAt = now;
      return { team, provision: input.decision === 'approve' };
    });
    if (result.provision) await this.provisionRoster(result.team.id, (input as { rosterId: string }).rosterId);
    return this.broker.project(this.broker.ports.read().find(team => team.id === input.teamId)!);
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
  /** Which of a Host's sessions may call: explicit entries, resolved to the sessions that hold them now, and the default for the rest. */
  enablement(hostId: string): { defaultEnabled: boolean; sessions: Array<{ providerId: string; nativeSessionId: string; enabled: boolean }> } {
    this.ports.assertHost(hostId);
    const state = this.ports.state();
    const sessions = (state?.enablement ?? []).filter(entry => entry.hostId === hostId).flatMap(entry => {
      try { const current = this.broker.ports.resolveSession(entry.hostId, entry.providerId, entry.nativeSessionId); return [{ providerId: current.providerId, nativeSessionId: current.nativeSessionId, enabled: entry.profileIds.length > 0 }]; }
      catch { return []; }
    });
    return { defaultEnabled: !!state?.profiles.some(profile => profile.enableByDefault), sessions };
  }
  /**
   * The status of groups the Host holds seats in. A group that no longer exists, or in which the Host has no seat, is missing:
   * the Host forgets its seats in archived and missing groups, which are never restored.
   */
  groupStates(hostId: string, teamIds: string[]): { states: Array<{ teamId: string; status: SavedTeam['status'] | 'missing' }> } {
    this.ports.assertHost(hostId);
    const teams = this.broker.ports.read();
    return { states: teamIds.map(teamId => {
      const team = teams.find(item => item.id === teamId);
      return { teamId, status: team?.callForSupport && team.members.some(member => member.hostId === hostId) ? team.status : 'missing' };
    }) };
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
