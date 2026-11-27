import { createHash, randomUUID } from 'node:crypto';
import { BOT_MESSAGE_LIMIT, itemTagText, nativeSessionRefKey, SUB_SESSION_LIVE_LIMIT, taskBriefText, taskResultText, taskSenderName, taskUpdateText, taskView, TASK_SUMMARY_LIMIT, TASK_TOLD_LIMIT, type Team, type TeamMessage,
  type TeamHostCall, type TeamMember, type TeamTask, type TaskOutcome, type TaskView } from '@orchardworks/agent-remote-protocol';
import { ACCOUNT_TEAM_LIMIT, assertTeamQueueCapacity, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import { pruneCoordination } from './coordination-retention.js';
import type { TeamBrokerPorts } from './teams.js';

/** What the Team broker lends sub-sessions. */
export interface TaskBrokerPorts {
  ports: TeamBrokerPorts;
  change<T>(update: (teams: SavedTeam[]) => T): Promise<T>;
  provision(teamId: string, memberId: string): Promise<Team>;
}
/** The Host facts sub-sessions depend on. */
export interface TaskPorts {
  /** The Host runs sub-sessions; others never see them. */
  capable(hostId: string): boolean;
  /** Throws unless the Host runs sub-sessions. */
  assertHost(hostId: string): void;
}
type CreateCall = Extract<TeamHostCall, { action: 'create_sub_session' }>;
type SendCall = Extract<TeamHostCall, { action: 'send_to_sub_session' }>;
type StatusCall = Extract<TeamHostCall, { action: 'get_sub_session_status' }>;
type StopCall = Extract<TeamHostCall, { action: 'stop_sub_session' }>;
type TellCall = Extract<TeamHostCall, { action: 'sub_told' }>;
/** What a sub-session's call is made by: the session itself, naming its Team and seat. */
type Worker = { teamId: string; memberId: string };

const fail = (message: string): never => { throw new Error(message); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const task = (team: Team): TeamTask => team.task ?? fail('Team is not a sub-session.');
const owner = (team: Team): TeamMember => team.members[1] ?? fail('Sub-session has no owner.');
/** A sub-session that is not ended can still be given work. */
const live = (state: TeamTask['state']) => state !== 'ended';
const clip = (text: string) => text.length > TASK_TOLD_LIMIT ? `${text.slice(0, TASK_TOLD_LIMIT - 1)}…` : text;
/** What its bot reads of a result: the start of it, with the way to read the rest. */
const cutResult = (text: string) => text.length > BOT_MESSAGE_LIMIT ? `${text.slice(0, BOT_MESSAGE_LIMIT - 1)}… (the rest: read_bot)` : text;
const withoutResult = (outcome: TaskOutcome) => outcome === 'failed' ? 'The turn failed without a message.' : outcome === 'interrupted' ? 'The turn was interrupted.' : 'The turn ended without a summary.';
/** Whether more input is on its way to a member: queued or being delivered. An input already accepted was taken by the turn that just ended; a held acknowledgement is not input. */
const inbound = (team: Team, memberId: string) => team.messages.some(message => message.to === memberId
  && (message.status === 'queued' && !message.ack || message.status === 'dispatching' || message.status === 'unknown'));
/** Queues an input; its id makes a repeated call queue it once. A person-started sub-session stays beside its conversation: nothing it says reaches its owner. */
function enqueue(team: SavedTeam, from: TeamMember, to: TeamMember, key: unknown[], text: string, now: number, ack?: true): TeamMessage {
  const id = digest(key);
  if (team.task?.startedBy === 'person' && to.id === owner(team).id) return { id, from: from.id, to: to.id, text, status: 'canceled' as const, createdAt: now };
  const existing = team.messages.find(message => message.id === id);
  if (existing) return existing;
  const message = { id, from: from.id, to: to.id, text, status: 'queued' as const, createdAt: now, ...(ack ? { ack } : {}) };
  assertTeamQueueCapacity(team, message);
  team.messages.push(message);
  return message;
}
function touch(team: SavedTeam, item: TeamTask, now: number) { item.updatedAt = now; team.revision++; team.updatedAt = now; }
function wait(team: SavedTeam, item: TeamTask, reason: NonNullable<TeamTask['waiting']>['reason'], text: string, now: number) {
  item.state = 'needs_input'; item.waiting = { reason, text: clip(text), since: now }; touch(team, item, now);
}
/** The session continues: what it waited for arrived, or new work did. A pending native interaction still waits for the person. */
function resume(team: SavedTeam, item: TeamTask, now: number) {
  if (item.waiting?.reason === 'interaction') return;
  item.state = 'working'; delete item.waiting; touch(team, item, now);
}
/** Ends a sub-session; what was still on its way to it is withdrawn and its running turn is asked to stop. */
function end(team: SavedTeam, item: TeamTask, by: NonNullable<TeamTask['endedBy']>, now: number) {
  const worker = team.members[0]!;
  for (const message of team.messages) if (message.to === worker.id && message.status === 'queued') message.status = 'canceled';
  worker.interrupt = now;
  item.state = 'ended'; item.endedBy = by; delete item.waiting; delete item.currentStep; touch(team, item, now);
}

/** A sub-session's presence: a pending interaction waits for the person, and the person typing into an idle one makes it work. */
export function taskPresence(team: SavedTeam, self: TeamMember, _before: TeamMember['activity'], interaction: string | undefined, now: number): void {
  const item = team.task;
  if (!item || self.role !== 'leader' || team.status !== 'active' || !live(item.state)) return;
  if (interaction && item.state !== 'needs_input') {
    wait(team, item, 'interaction', interaction, now);
    enqueue(team, self, owner(team), ['sub-interaction', team.id, now], taskUpdateText({ taskId: team.id, kind: 'needs_you', label: item.title, body: interaction }), now);
    return;
  }
  if (!interaction && item.state === 'needs_input' && item.waiting?.reason === 'interaction') { item.state = self.activity === 'busy' ? 'working' : 'idle'; delete item.waiting; touch(team, item, now); return; }
  if (self.activity === 'busy' && item.state === 'idle') { item.state = 'working'; touch(team, item, now); }
  // A turn ended after the latest work was sent and nothing waits: the session is idle, though its end was reported before the work's delivery settled.
  if (self.activity === 'idle' && item.state === 'working' && item.result && item.result.at >= (item.lastWork?.at ?? 0) && !inbound(team, self.id)) { item.state = 'idle'; touch(team, item, now); }
}
/** A delivery to the session whose outcome is unknown: it may not have that input, so it waits for a decision and the input is never sent again. */
export function taskSettled(team: SavedTeam, message: TeamMessage, now: number): void {
  const item = team.task;
  if (!item || message.to !== team.members[0]?.id || message.status !== 'unknown' || !live(item.state) || item.state === 'needs_input') return;
  wait(team, item, 'input_unknown', 'Whether the sub-session received its last input is unknown, so it is not sent again.', now);
  enqueue(team, team.members[0]!, owner(team), ['sub-unknown', team.id, message.id], taskUpdateText({ taskId: team.id, kind: 'needs_you', label: item.title,
    body: 'Whether the sub-session received its last input is unknown, so it is not sent again. Send it again with send_to_sub_session, or stop it.' }), now);
}
/** The person ends a sub-session; its bot is told, unless the person started it themselves. */
export function taskAction(team: SavedTeam, now: number, by: 'person' | 'bot' | 'chain' | 'bot_retired' = 'person'): void {
  const item = task(team);
  if (!live(item.state)) return;
  const worker = team.members[0]!, main = owner(team);
  end(team, item, by, now);
  if (by === 'person') enqueue(team, worker, main, ['sub-ended', team.id], taskUpdateText({ taskId: team.id, kind: 'cancelled', label: item.title, body: 'The person ended this sub-session.' }), now);
}
/** The line naming the board item a sub-session works on, in the frames of its session and its bot; none without one. */
const tagOf = (team: Team, from: string): { tag: string } | Record<string, never> => team.task?.item ? { tag: itemTagText({ key: team.task.item.key, title: team.task.item.title, from }) } : {};
const sameKey = (resolve: TeamBrokerPorts['resolveSession'], hostId: string, providerId: string, nativeSessionId: string) => {
  try { return nativeSessionRefKey(resolve(hostId, providerId, nativeSessionId)); } catch { return undefined; }
};

export { quoteFrames } from '@orchardworks/agent-remote-protocol';
/** The session's first input. */
export const briefText = (team: Team): string => { const item = task(team); return taskBriefText({ taskId: team.id, from: team.source.title, title: item.title, brief: item.brief, ...tagOf(team, team.source.title) }); };
/** The bot's view of a result. */
export const resultText = (team: Team): string => {
  const item = task(team), result = item.result ?? fail('The sub-session has no result.');
  return taskResultText({ taskId: team.id, outcome: result.outcome, title: item.title, summary: cutResult(result.text), ...tagOf(team, item.title) });
};

export { taskView };

/** The sub-sessions whose owner seat holds the given session's role now. */
export function ownerTasks(teams: SavedTeam[], resolve: TeamBrokerPorts['resolveSession'], hostId: string, session: { providerId: string; nativeSessionId: string }): SavedTeam[] {
  const target = sameKey(resolve, hostId, session.providerId, session.nativeSessionId);
  if (!target) return [];
  return teams.filter(team => {
    if (!team.task) return false;
    const seat = owner(team);
    return seat.hostId === hostId && !!seat.nativeSessionId && sameKey(resolve, seat.hostId, seat.providerId, seat.nativeSessionId) === target;
  });
}
/** The live sub-sessions a bot started itself: the ones its limit counts, never a person's own `/side`. */
export const botLive = (teams: SavedTeam[]) => teams.filter(team => team.task && live(team.task.state) && team.task.startedBy !== 'person');

/** Sub-session creation, work, status and results, on top of the Team broker. */
export class TaskGroups {
  constructor(private readonly broker: TaskBrokerPorts, private readonly ports: TaskPorts) {}
  capable(hostId: string): boolean { return this.ports.capable(hostId); }
  /** `where`: the session runs on another Host of the account, or in a folder chosen for it, instead of beside its owner. */
  async create(hostId: string, call: Omit<CreateCall, 'action' | 'trackedTaskKeys' | 'cause'> & { item?: TeamTask['item'] }, options: { startedBy?: 'person'; where?: { hostId: string; cwd?: string } } = {}): Promise<{ taskId: string; state: TaskView['state']; message: string }> {
    this.ports.assertHost(hostId);
    const workerHost = options.where?.hostId ?? hostId, cwd = options.where?.cwd;
    this.ports.assertHost(workerHost);
    const providerId = call.provider ?? call.owner.providerId;
    this.broker.ports.assertHost(workerHost, providerId);
    if (call.workspace === 'worktree' && !call.commit) fail('A worktree sub-session needs the commit it starts from.');
    const resolve = this.broker.ports.resolveSession;
    if (!sameKey(resolve, hostId, call.owner.providerId, call.owner.nativeSessionId)) fail('The owner session is not on this Host.');
    const created = await this.broker.change(teams => {
      const now = this.broker.ports.now();
      const existing = teams.find(team => team.operationId === call.operationId);
      if (existing) {
        const item = existing.task, seat = existing.task && owner(existing);
        const worker = existing.members[0];
        if (!item || seat?.nativeSessionId !== call.owner.nativeSessionId || seat.hostId !== hostId || item.title !== call.name || item.brief !== call.prompt
          || (item.workspace ?? 'same') !== (call.workspace ?? 'same') || worker?.providerId !== providerId || worker.model !== call.model
          || worker.hostId !== workerHost || (cwd !== undefined && worker.cwd !== cwd)) fail('Sub-session identity has different input.');
        return existing;
      }
      if (options.startedBy !== 'person') {
        const mine = botLive(ownerTasks(plain(teams), resolve, hostId, call.owner));
        if (mine.length >= SUB_SESSION_LIVE_LIMIT) fail(`You already have ${mine.length} live sub-sessions; stop one you will not use again, or send it the work. Live now: ${mine.map(team => `${team.task!.title} (${team.task!.state})`).join(', ')}.`);
      }
      pruneCoordination(teams, 1);
      if (plain(teams).length >= ACCOUNT_TEAM_LIMIT) fail('Team capacity reached.');
      const worker: TeamMember = { id: randomUUID(), role: 'leader', hostId: workerHost, providerId, name: 'Sub-session', responsibility: call.name, ...(cwd ? { cwd } : {}),
        creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now, ...(call.model ? { model: call.model } : {}),
        ...(call.workspace === 'read_only' ? { access: 'read_only' as const } : {}), ...(call.workspace === 'worktree' ? { workspace: { kind: 'worktree' as const, commit: call.commit! } } : {}) };
      const main: TeamMember = { id: randomUUID(), role: 'requester', hostId, providerId: call.owner.providerId, nativeSessionId: call.owner.nativeSessionId,
        name: taskSenderName(call.owner.title), responsibility: 'The session that owns this sub-session.', creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now };
      const team: SavedTeam = { id: randomUUID(), operationId: call.operationId, revision: 1, title: call.name, status: 'active', members: [worker, main], messages: [],
        source: { hostId, providerId: call.owner.providerId, nativeSessionId: call.owner.nativeSessionId, title: taskSenderName(call.owner.title) },
        task: { title: call.name, brief: call.prompt, ...(call.workspace && call.workspace !== 'same' ? { workspace: call.workspace } : {}),
          ...(call.item ? { item: call.item } : {}), ...(options.startedBy ? { startedBy: options.startedBy } : {}), state: 'working', lastWork: { title: call.name.slice(0, 120), at: now }, createdAt: now, updatedAt: now }, createdAt: now, updatedAt: now };
      const brief = { id: digest(['sub-brief', team.id]), from: main.id, to: worker.id, text: briefText(team), status: 'queued' as const, createdAt: now };
      assertTeamQueueCapacity(team, brief);
      team.messages.push(brief);
      teams.push(team);
      return team;
    });
    const team = await this.provision(created.id);
    const view = taskView(team);
    return { taskId: view.taskId, state: view.state,
      message: view.state === 'needs_input' ? `Sub-session ${view.taskId} is recorded, but whether its session started is unknown${view.worker.error ? ` (${view.worker.error})` : ''}. Tell the person; stop it with stop_sub_session if it should not run.`
        : view.state === 'queued' ? `Sub-session ${view.taskId} is recorded but its session is not ready${view.worker.error ? `: ${view.worker.error}` : ''}.`
        : `Sub-session ${view.taskId} started. Its result arrives later as input; keep the person informed meanwhile.` };
  }
  /** The owner's seat binds first; the session starts in the owner's directory. */
  async provision(teamId: string): Promise<Team> {
    const saved = this.broker.ports.read().find(team => team.id === teamId) ?? fail('Sub-session not found.');
    let team = await this.broker.provision(teamId, owner(saved).id);
    if (owner(team).creation !== 'ready') return team;
    team = await this.broker.provision(teamId, team.members[0]!.id);
    if (team.members[0]!.creation !== 'unknown' || team.task?.state !== 'working') return team;
    // Whether the session exists is unknown, and it is never created twice: the sub-session waits for the person or its bot.
    return this.broker.change(teams => {
      const saved = teams.find(item => item.id === teamId) ?? fail('Sub-session not found.'), item = task(saved);
      if (item.state === 'working' && saved.members[0]!.creation === 'unknown') wait(saved, item, 'input_unknown', 'Whether the sub-session started is unknown.', this.broker.ports.now());
      return saved;
    });
  }
  /** The sub-sessions a session started, as the page and the bot read them; a person's own `/side` is not among a bot's. */
  status(hostId: string, call: Pick<StatusCall, 'owner' | 'subSessionIds'>, ids: (team: SavedTeam) => string): { sub_sessions: TaskView[] } {
    this.ports.assertHost(hostId);
    const mine = botLive(ownerTasks(this.broker.ports.read(), this.broker.ports.resolveSession, hostId, call.owner));
    const wanted = call.subSessionIds ? mine.filter(team => call.subSessionIds!.includes(ids(team))) : mine;
    return { sub_sessions: wanted.map(taskView).sort((a, b) => b.updatedAt - a.updatedAt) };
  }
  /** More work for a sub-session of the caller: it is delivered between turns; `interrupt` stops the running turn first. */
  send(hostId: string, call: Pick<SendCall, 'owner' | 'operationId' | 'text' | 'title' | 'delivery'> & { teamId: string; item?: TeamTask['item'] }, tag?: string): Promise<{ taskId: string; state: TeamTask['state'] }> {
    return this.ownerChange(hostId, call, (team, item, now) => {
      if (!live(item.state)) fail('This sub-session has ended. Start a new one for more work.');
      const main = owner(team), worker = team.members[0]!;
      const before = team.messages.length;
      enqueue(team, main, worker, ['sub-work', team.id, call.operationId], taskUpdateText({ taskId: team.id, kind: 'message', label: main.name, body: call.text, ...(tag ? { tag } : tagOf(team, main.name)) }), now);
      if (team.messages.length === before) return { taskId: team.id, state: item.state };
      if (call.delivery === 'interrupt') worker.interrupt = now;
      if (call.item) item.item = call.item;
      item.lastWork = { title: call.title.slice(0, 120), at: now }; delete item.currentStep;
      resume(team, item, now);
      return { taskId: team.id, state: item.state };
    });
  }
  /** A bot (or the person) ends a sub-session. */
  stop(hostId: string, call: { owner: { providerId: string; nativeSessionId: string }; teamId: string }): Promise<{ taskId: string; state: TeamTask['state'] }> {
    return this.ownerChange(hostId, call, (team, item, now) => { taskAction(team, now, 'bot'); return { taskId: team.id, state: item.state }; });
  }
  /** A sub-session reports what it is doing, or the result of the piece of work it finished (communicate_update). */
  update(hostId: string, call: Worker & { currentStep?: string; finalSummary?: string }): Promise<{ taskId: string; state: TeamTask['state'] }> {
    return this.workerChange(hostId, call, (team, _self, item, now) => {
      if (call.currentStep) item.currentStep = call.currentStep;
      if (call.finalSummary) item.reportedSummary = call.finalSummary.slice(0, TASK_SUMMARY_LIMIT);
      touch(team, item, now);
      return { taskId: team.id, state: item.state };
    });
  }
  /**
   * The session's turn ended: how it ended and its final text. The result is the `final_summary` the session reported during the turn, or
   * the final text; its bot is told once, and the session is idle with its context kept. A turn the session ran for a person's own `/side` tells no bot.
   */
  turnEnded(hostId: string, call: Worker & { outcome: TaskOutcome; text?: string }): Promise<{ taskId: string; state: TeamTask['state'] }> {
    return this.workerChange(hostId, call, (team, self, item, now) => {
      item.result = { outcome: call.outcome, text: (item.reportedSummary ?? call.text ?? withoutResult(call.outcome)).slice(0, TASK_SUMMARY_LIMIT), at: now };
      delete item.reportedSummary;
      delete item.currentStep;
      if (item.state !== 'needs_input' || item.waiting?.reason !== 'interaction') { delete item.waiting; item.state = inbound(team, self.id) ? 'working' : 'idle'; }
      touch(team, item, now);
      enqueue(team, self, owner(team), ['sub-result', team.id, now], resultText(team), now);
      return { taskId: team.id, state: item.state };
    });
  }
  /** Tells a sub-session something the Relay wrote from the record; one that ended is not told. */
  notice(teamId: string, key: unknown[], text: string): Promise<void> {
    return this.broker.change(teams => {
      const team = teams.find(item => item.id === teamId), now = this.broker.ports.now();
      if (!team?.task || team.status !== 'active' || !live(team.task.state)) return;
      enqueue(team, owner(team), team.members[0]!, ['sub-notice', team.id, ...key], text, now);
    });
  }
  /** The person wrote to the session directly: its bot is told, and what the session waited for may have arrived. */
  tell(hostId: string, call: Pick<TellCall, 'teamId' | 'memberId' | 'operationId' | 'text'>): Promise<{ taskId: string; state: TeamTask['state'] }> {
    return this.workerChange(hostId, call, (team, self, item, now) => {
      if (!live(item.state)) return { taskId: team.id, state: item.state };
      enqueue(team, self, owner(team), ['sub-told', team.id, call.operationId], taskUpdateText({ taskId: team.id, kind: 'told', label: item.title, body: clip(call.text) }), now);
      if (item.state === 'idle') { item.state = 'working'; touch(team, item, now); }
      else resume(team, item, now);
      return { taskId: team.id, state: item.state };
    });
  }
  private ownerChange<T>(hostId: string, call: { owner: { providerId: string; nativeSessionId: string }; teamId: string }, update: (team: SavedTeam, item: TeamTask, now: number) => T): Promise<T> {
    this.ports.assertHost(hostId);
    return this.broker.change(teams => {
      const team = ownerTasks(teams, this.broker.ports.resolveSession, hostId, call.owner).find(item => item.id === call.teamId) ?? fail('Sub-session not found for this session.');
      if (team.status !== 'active') fail('This sub-session is gone.');
      return update(team, task(team), this.broker.ports.now());
    });
  }
  private workerChange<T>(hostId: string, call: Worker, update: (team: SavedTeam, self: TeamMember, item: TeamTask, now: number) => T): Promise<T> {
    this.ports.assertHost(hostId);
    return this.broker.change(teams => {
      const team = teams.find(item => item.id === call.teamId) ?? fail('Sub-session not found.'), item = task(team);
      const self = team.members.find(member => member.id === call.memberId) ?? fail('Team member not found.');
      if (self.hostId !== hostId || self.creation !== 'ready' || self.role !== 'leader') fail('Only the sub-session\'s own session does this.');
      if (team.status !== 'active') fail('This sub-session is gone.');
      return update(team, self, item, this.broker.ports.now());
    });
  }
}
