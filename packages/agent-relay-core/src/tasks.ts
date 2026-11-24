import { createHash, randomUUID } from 'node:crypto';
import { itemTagText, nativeSessionRefKey, TASK_RUNNING_LIMIT, taskBriefText, taskResultText, taskSenderName, taskUpdateText, taskView, TASK_TOLD_LIMIT, type Team, type TeamMessage, type TeamHostCall, type TeamMember, type TeamTask, type TaskView } from '@orchardworks/agent-remote-protocol';
import { ACCOUNT_TEAM_LIMIT, assertTeamQueueCapacity, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import { pruneCoordination } from './coordination-retention.js';
import type { TeamBrokerPorts } from './teams.js';

/** What the Team broker lends tasks. */
export interface TaskBrokerPorts {
  ports: TeamBrokerPorts;
  change<T>(update: (teams: SavedTeam[]) => T): Promise<T>;
  provision(teamId: string, memberId: string): Promise<Team>;
}
/** The Host facts tasks depend on. */
export interface TaskPorts {
  /** The Host runs tasks; others never see them. */
  capable(hostId: string): boolean;
  /** Throws unless the Host runs tasks. */
  assertHost(hostId: string): void;
}
type CreateCall = Extract<TeamHostCall, { action: 'create_task' }>;
type StatusCall = Extract<TeamHostCall, { action: 'task_status' }>;
type ReportCall = Extract<TeamHostCall, { action: 'report_task' }>;
type MessageCall = Extract<TeamHostCall, { action: 'message_task' }>;
type OwnerCall = Extract<TeamHostCall, { action: 'cancel_task' | 'mark_task_done' }>;
type AskCall = Extract<TeamHostCall, { action: 'ask_owner' }>;
type TellCall = Extract<TeamHostCall, { action: 'tell_task' }>;

const STATUS_LIMIT = 20;
const fail = (message: string): never => { throw new Error(message); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const task = (team: Team): TeamTask => team.task ?? fail('Team is not a task.');
const owner = (team: Team): TeamMember => team.members[1] ?? fail('Task has no owner.');
const finished = (state: TeamTask['state']) => state === 'done' || state === 'failed' || state === 'cancelled';
const running = (state: TeamTask['state']) => state === 'working' || state === 'needs_input';
const clip = (text: string) => text.length > TASK_TOLD_LIMIT ? `${text.slice(0, TASK_TOLD_LIMIT - 1)}…` : text;
/** Whether more input is on its way to a member: queued, being delivered, or accepted but not yet started; a held acknowledgement is not input. */
const inbound = (team: Team, memberId: string) => team.messages.some(message => message.to === memberId
  && (message.status === 'queued' && !message.ack || message.status === 'dispatching' || message.status === 'unknown' || message.status === 'accepted' && message.acceptance !== 'started' && message.acceptance !== 'handled'));
/** Queues a task input; its id makes a repeated call queue it once. */
function enqueue(team: SavedTeam, from: TeamMember, to: TeamMember, key: unknown[], text: string, now: number, ack?: true): TeamMessage {
  const id = digest(key);
  // A side stays beside the conversation it was asked from: what it tells its owner is on the page (its state, its result), never an input.
  if (team.task?.side && to.id === owner(team).id) return { id, from: from.id, to: to.id, text, status: 'canceled' as const, createdAt: now };
  const existing = team.messages.find(message => message.id === id);
  if (existing) return existing;
  const message = { id, from: from.id, to: to.id, text, status: 'queued' as const, createdAt: now, ...(ack ? { ack } : {}) };
  assertTeamQueueCapacity(team, message);
  team.messages.push(message);
  return message;
}
function touch(team: SavedTeam, item: TeamTask, now: number) { item.updatedAt = now; team.revision++; team.updatedAt = now; }
function wait(team: SavedTeam, item: TeamTask, reason: NonNullable<TeamTask['waiting']>['reason'], text: string, now: number) {
  item.state = 'needs_input'; item.waiting = { reason, text, since: now }; touch(team, item, now);
}
/** The worker continues: what it waited for arrived. A pending native interaction still waits for the person. */
function resume(team: SavedTeam, item: TeamTask, now: number) {
  if (item.state !== 'needs_input' || item.waiting?.reason === 'interaction') return;
  item.state = 'working'; delete item.waiting; delete item.reminded; touch(team, item, now);
}
/** Ends a task without a report from its worker; what was still on its way to the worker is withdrawn. */
function close(team: SavedTeam, item: TeamTask, state: 'done' | 'cancelled', summary: string, now: number) {
  const worker = team.members[0]!;
  for (const message of team.messages) if (message.to === worker.id && message.status === 'queued') message.status = 'canceled';
  item.state = state; delete item.waiting;
  if (state === 'done') item.result = { status: 'done', summary, reportedAt: now };
  touch(team, item, now);
}
/** The worker's turn ended without a report: one reminder, then the task waits for the owner or the person. */
function turnEnded(team: SavedTeam, item: TeamTask, now: number) {
  const worker = team.members[0]!, main = owner(team);
  if (item.reminded === undefined) {
    item.reminded = now; touch(team, item, now);
    enqueue(team, main, worker, ['task-reminder', team.id], taskUpdateText({ taskId: team.id, kind: 'reminder', label: item.title, body: 'Report this task.' }), now);
    return;
  }
  wait(team, item, 'no_report', 'The worker stopped without reporting.', now);
  enqueue(team, worker, main, ['task-no-report', team.id, now], taskUpdateText({ taskId: team.id, kind: 'needs_you', label: item.title,
    body: 'The worker ended its turns twice without a report. Message it with message_task, or cancel the task or mark it done.' }), now);
}

/** A task worker's presence: a pending interaction waits for the person, and a turn that ended without a report is followed up. */
export function taskPresence(team: SavedTeam, self: TeamMember, before: TeamMember['activity'], interaction: string | undefined, now: number): void {
  const item = team.task;
  if (!item || self.role !== 'leader' || team.status !== 'active') return;
  if (interaction && item.state === 'working') {
    wait(team, item, 'interaction', interaction, now);
    enqueue(team, self, owner(team), ['task-interaction', team.id, now], taskUpdateText({ taskId: team.id, kind: 'needs_you', label: item.title, body: interaction }), now);
    return;
  }
  if (!interaction && item.state === 'needs_input' && item.waiting?.reason === 'interaction') { item.state = 'working'; delete item.waiting; touch(team, item, now); return; }
  if (before === 'busy' && self.activity === 'idle' && item.state === 'working' && !inbound(team, self.id)) turnEnded(team, item, now);
}
/** A delivery to the worker whose outcome is unknown: the worker may not have its brief, so the task waits for a decision. */
export function taskSettled(team: SavedTeam, message: TeamMessage, now: number): void {
  const item = team.task;
  if (!item || message.to !== team.members[0]?.id || message.status !== 'unknown' || item.state !== 'working') return;
  wait(team, item, 'brief_unknown', 'Whether the worker received its input is unknown.', now);
  enqueue(team, team.members[0]!, owner(team), ['task-unknown', team.id, message.id], taskUpdateText({ taskId: team.id, kind: 'needs_you', label: item.title,
    body: 'Whether the worker received its last input is unknown, so it is not sent again. Send it again with message_task, or cancel the task.' }), now);
}
/** The person stops a task or takes it as done; the owner is told. */
export function taskAction(team: SavedTeam, action: 'cancel_task' | 'mark_task_done', now: number): void {
  const item = task(team);
  if (!running(item.state)) fail('This task is no longer running.');
  const worker = team.members[0]!, main = owner(team);
  if (action === 'cancel_task') {
    close(team, item, 'cancelled', '', now);
    enqueue(team, worker, main, ['task-cancelled', team.id], taskUpdateText({ taskId: team.id, kind: 'cancelled', label: item.title, body: 'The person stopped this task.' }), now);
  } else {
    close(team, item, 'done', 'The person marked this task done.', now);
    enqueue(team, worker, main, ['task-result', team.id], resultText(team), now);
  }
}
/** The line naming the board item a task serves, in the frames of its worker and its chief; none for a task without one. */
const tagOf = (team: Team, from: string): { tag: string } | Record<string, never> => team.task?.item ? { tag: itemTagText({ key: team.task.item.key, title: team.task.item.title, from }) } : {};
const sameKey = (resolve: TeamBrokerPorts['resolveSession'], hostId: string, providerId: string, nativeSessionId: string) => {
  try { return nativeSessionRefKey(resolve(hostId, providerId, nativeSessionId)); } catch { return undefined; }
};

export { quoteFrames } from '@orchardworks/agent-remote-protocol';
/** The worker's first input. */
export const briefText = (team: Team): string => { const item = task(team); return taskBriefText({ taskId: team.id, from: team.source.title, title: item.title, brief: item.brief, ...(item.doneWhen ? { doneWhen: item.doneWhen } : {}), ...(item.side ? { side: true as const } : {}), ...tagOf(team, team.source.title) }); };
/** The owner's view of a report. */
export const resultText = (team: Team): string => { const item = task(team), result = item.result ?? fail('The task has no result.'); return taskResultText({ taskId: team.id, status: result.status, title: item.title, summary: result.summary, ...tagOf(team, item.title) }); };

export { taskView };

/** The tasks whose owner seat holds the given session's role now. */
export function ownerTasks(teams: SavedTeam[], resolve: TeamBrokerPorts['resolveSession'], hostId: string, session: { providerId: string; nativeSessionId: string }): SavedTeam[] {
  const target = sameKey(resolve, hostId, session.providerId, session.nativeSessionId);
  if (!target) return [];
  return teams.filter(team => {
    if (!team.task) return false;
    const seat = owner(team);
    return seat.hostId === hostId && !!seat.nativeSessionId && sameKey(resolve, seat.hostId, seat.providerId, seat.nativeSessionId) === target;
  });
}

/** Task creation, status and reports, on top of the Team broker. */
export class TaskGroups {
  constructor(private readonly broker: TaskBrokerPorts, private readonly ports: TaskPorts) {}
  capable(hostId: string): boolean { return this.ports.capable(hostId); }
  async create(hostId: string, call: CreateCall, options: { side?: true } = {}): Promise<{ taskId: string; state: TaskView['state']; message: string }> {
    this.ports.assertHost(hostId);
    const providerId = call.provider ?? call.owner.providerId;
    this.broker.ports.assertHost(hostId, providerId);
    if (call.workspace === 'worktree' && !call.commit) fail('A worktree task needs the commit it starts from.');
    const resolve = this.broker.ports.resolveSession;
    if (!sameKey(resolve, hostId, call.owner.providerId, call.owner.nativeSessionId)) fail('The owner session is not on this Host.');
    const created = await this.broker.change(teams => {
      const now = this.broker.ports.now();
      const existing = teams.find(team => team.operationId === call.operationId);
      if (existing) {
        const item = existing.task, seat = existing.task && owner(existing);
        const worker = existing.members[0];
        if (!item || seat?.nativeSessionId !== call.owner.nativeSessionId || seat.hostId !== hostId || item.title !== call.title || item.brief !== call.brief || item.doneWhen !== call.doneWhen
          || (item.workspace ?? 'same') !== (call.workspace ?? 'same') || worker?.providerId !== providerId || worker.model !== call.model) fail('Task identity has different input.');
        return existing;
      }
      const count = ownerTasks(plain(teams), resolve, hostId, call.owner).filter(team => running(team.task!.state)).length;
      if (count >= TASK_RUNNING_LIMIT) fail(`This session already has ${count} tasks running. Wait for a result before starting another.`);
      pruneCoordination(teams, 1);
      if (plain(teams).length >= ACCOUNT_TEAM_LIMIT) fail('Team capacity reached.');
      const worker: TeamMember = { id: randomUUID(), role: 'leader', hostId, providerId, name: 'Worker', responsibility: call.title,
        creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now, ...(call.model ? { model: call.model } : {}),
        ...(call.workspace === 'read_only' ? { access: 'read_only' as const } : {}), ...(call.workspace === 'worktree' ? { workspace: { kind: 'worktree' as const, commit: call.commit! } } : {}) };
      const main: TeamMember = { id: randomUUID(), role: 'requester', hostId, providerId: call.owner.providerId, nativeSessionId: call.owner.nativeSessionId,
        name: taskSenderName(call.owner.title), responsibility: 'The main session that owns this task.', creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now };
      const team: SavedTeam = { id: randomUUID(), operationId: call.operationId, revision: 1, title: call.title, status: 'active', members: [worker, main], messages: [],
        source: { hostId, providerId: call.owner.providerId, nativeSessionId: call.owner.nativeSessionId, title: taskSenderName(call.owner.title) },
        task: { title: call.title, brief: call.brief, ...(call.doneWhen ? { doneWhen: call.doneWhen } : {}), ...(call.workspace && call.workspace !== 'same' ? { workspace: call.workspace } : {}),
          ...(call.item ? { item: call.item } : {}), ...(options.side ? { side: true as const } : {}), state: 'working', createdAt: now, updatedAt: now }, createdAt: now, updatedAt: now };
      const brief = { id: digest(['task-brief', team.id]), from: main.id, to: worker.id, text: briefText(team), status: 'queued' as const, createdAt: now };
      assertTeamQueueCapacity(team, brief);
      team.messages.push(brief);
      teams.push(team);
      return team;
    });
    const team = await this.provision(created.id);
    const view = taskView(team);
    return { taskId: view.taskId, state: view.state,
      message: view.state === 'needs_input' ? `Task ${view.taskId} is recorded, but whether its worker session started is unknown${view.worker.error ? ` (${view.worker.error})` : ''}. Tell the person; cancel it with cancel_task if it should not run.`
        : view.state === 'queued' ? `Task ${view.taskId} is recorded but its worker is not ready${view.worker.error ? `: ${view.worker.error}` : ''}.`
        : `Task ${view.taskId} started. Its result arrives later as input; keep the person informed meanwhile.` };
  }
  /** The owner's seat binds first; the worker starts in the owner's directory. */
  async provision(teamId: string): Promise<Team> {
    const saved = this.broker.ports.read().find(team => team.id === teamId) ?? fail('Task not found.');
    let team = await this.broker.provision(teamId, owner(saved).id);
    if (owner(team).creation !== 'ready') return team;
    team = await this.broker.provision(teamId, team.members[0]!.id);
    if (team.members[0]!.creation !== 'unknown' || team.task?.state !== 'working') return team;
    // Whether the worker session exists is unknown, and it is never created twice: the task waits for the person or the owner.
    return this.broker.change(teams => {
      const saved = teams.find(item => item.id === teamId) ?? fail('Task not found.'), item = task(saved);
      if (item.state === 'working' && saved.members[0]!.creation === 'unknown') wait(saved, item, 'brief_unknown', 'Whether the worker session started is unknown.', this.broker.ports.now());
      return saved;
    });
  }
  status(hostId: string, call: StatusCall): { tasks: TaskView[] } | TaskView {
    this.ports.assertHost(hostId);
    const mine = ownerTasks(this.broker.ports.read(), this.broker.ports.resolveSession, hostId, call.owner);
    if (call.taskId) return taskView(mine.find(team => team.id === call.taskId) ?? fail('Task not found for this session.'));
    return { tasks: mine.map(taskView).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, STATUS_LIMIT) };
  }
  report(hostId: string, call: ReportCall): Promise<{ taskId: string; state: TeamTask['state'] }> {
    this.ports.assertHost(hostId);
    return this.broker.change(teams => {
      const team = teams.find(item => item.id === call.teamId) ?? fail('Task not found.'), item = task(team), now = this.broker.ports.now();
      const self = team.members.find(member => member.id === call.memberId) ?? fail('Team member not found.');
      if (self.hostId !== hostId || self.creation !== 'ready' || self.role !== 'leader') fail('Only the task\'s worker reports it.');
      if (item.result) {
        if (item.result.status === call.status && item.result.summary === call.summary) return { taskId: team.id, state: item.state };
        fail('This task was already reported.');
      }
      if (!running(item.state) || team.status !== 'active') fail('This task is no longer running.');
      item.result = { status: call.status, summary: call.summary, reportedAt: now }; item.state = call.status; delete item.waiting; touch(team, item, now);
      enqueue(team, self, owner(team), ['task-result', team.id], resultText(team), now);
      return { taskId: team.id, state: item.state };
    });
  }
  /** The owner sends its worker input; it answers a question the worker asked. */
  message(hostId: string, call: MessageCall, tag?: string, ack?: true): Promise<{ taskId: string; state: TeamTask['state'] }> {
    return this.ownerChange(hostId, call, (team, item, now) => {
      if (!running(item.state)) fail('This task is finished. Start a new task for more work.');
      const main = owner(team);
      enqueue(team, main, team.members[0]!, ['task-message', team.id, call.operationId], taskUpdateText({ taskId: team.id, kind: 'message', label: main.name, body: call.text, ...(tag ? { tag } : tagOf(team, main.name)) }), now, ack);
      if (!ack) resume(team, item, now);
      return { taskId: team.id, state: item.state };
    });
  }
  /** The owner stops a task, or takes it as done. */
  finish(hostId: string, call: OwnerCall): Promise<{ taskId: string; state: TeamTask['state'] }> {
    return this.ownerChange(hostId, call, (team, item, now) => {
      if (call.action === 'cancel_task' ? item.state === 'cancelled' : item.state === 'done') return { taskId: team.id, state: item.state };
      if (!running(item.state)) fail('This task is no longer running.');
      close(team, item, call.action === 'cancel_task' ? 'cancelled' : 'done', call.action === 'mark_task_done' ? call.summary ?? 'Marked done by its owner.' : '', now);
      return { taskId: team.id, state: item.state };
    });
  }
  /** The worker asks its owner; the task waits for the answer. */
  ask(hostId: string, call: AskCall): Promise<{ taskId: string; state: TeamTask['state'] }> {
    return this.workerChange(hostId, call, (team, self, item, now) => {
      if (item.state === 'needs_input' && item.waiting?.reason === 'question' && item.waiting.text === call.question) return { taskId: team.id, state: item.state };
      if (item.state !== 'working') fail('This task is not running.');
      wait(team, item, 'question', call.question, now);
      enqueue(team, self, owner(team), ['task-question', team.id, now], taskUpdateText({ taskId: team.id, kind: 'question', label: item.title, body: call.question, ...tagOf(team, item.title) }), now);
      return { taskId: team.id, state: item.state };
    });
  }
  /** The temporary bot the task is tells its chief where its work stands. */
  progress(hostId: string, call: { teamId: string; memberId: string; operationId: string; text: string; ack?: true }): Promise<{ taskId: string; state: TeamTask['state'] }> {
    return this.workerChange(hostId, call, (team, self, item, now) => {
      if (!running(item.state)) fail('This task is no longer running.');
      enqueue(team, self, owner(team), ['task-progress', team.id, call.operationId], taskUpdateText({ taskId: team.id, kind: 'progress', label: item.title, body: call.text, ...tagOf(team, item.title) }), now, call.ack);
      return { taskId: team.id, state: item.state };
    });
  }
  /** A bot that is not the temporary bot's chief writes to it: the worker reads it as input from that bot. */
  input(teamId: string, from: string, call: { operationId: string; text: string; tag?: string; ack?: true }): Promise<{ taskId: string; state: TeamTask['state'] }> {
    return this.broker.change(teams => {
      const team = teams.find(item => item.id === teamId) ?? fail('Task not found.'), item = task(team), now = this.broker.ports.now();
      if (team.status !== 'active' || !running(item.state)) fail('This bot has finished its work.');
      enqueue(team, owner(team), team.members[0]!, ['task-input', team.id, from, call.operationId], taskUpdateText({ taskId: team.id, kind: 'message', label: from, body: call.text, ...(call.tag ? { tag: call.tag } : tagOf(team, from)) }), now, call.ack);
      // An acknowledgement answers nothing the bot waited for.
      if (!call.ack) resume(team, item, now);
      return { taskId: team.id, state: item.state };
    });
  }
  /** Tells a temporary bot something the Relay wrote from the record; a bot that finished is not told. */
  notice(teamId: string, key: unknown[], text: string): Promise<void> {
    return this.broker.change(teams => {
      const team = teams.find(item => item.id === teamId), now = this.broker.ports.now();
      if (!team?.task || team.status !== 'active' || !running(team.task.state)) return;
      enqueue(team, owner(team), team.members[0]!, ['task-notice', team.id, ...key], text, now);
    });
  }
  /** The person wrote to the worker directly: the owner is told, and what the worker waited for may have arrived. */
  tell(hostId: string, call: TellCall): Promise<{ taskId: string; state: TeamTask['state'] }> {
    return this.workerChange(hostId, call, (team, self, item, now) => {
      if (!running(item.state)) return { taskId: team.id, state: item.state };
      enqueue(team, self, owner(team), ['task-told', team.id, call.operationId], taskUpdateText({ taskId: team.id, kind: 'told', label: item.title, body: clip(call.text) }), now);
      resume(team, item, now);
      return { taskId: team.id, state: item.state };
    });
  }
  private ownerChange<T>(hostId: string, call: { owner: { providerId: string; nativeSessionId: string }; taskId: string }, update: (team: SavedTeam, item: TeamTask, now: number) => T): Promise<T> {
    this.ports.assertHost(hostId);
    return this.broker.change(teams => {
      const team = ownerTasks(teams, this.broker.ports.resolveSession, hostId, call.owner).find(item => item.id === call.taskId) ?? fail('Task not found for this session.');
      if (team.status !== 'active') fail('This task is no longer running.');
      return update(team, task(team), this.broker.ports.now());
    });
  }
  private workerChange<T>(hostId: string, call: { teamId: string; memberId: string }, update: (team: SavedTeam, self: TeamMember, item: TeamTask, now: number) => T): Promise<T> {
    this.ports.assertHost(hostId);
    return this.broker.change(teams => {
      const team = teams.find(item => item.id === call.teamId) ?? fail('Task not found.'), item = task(team);
      const self = team.members.find(member => member.id === call.memberId) ?? fail('Team member not found.');
      if (self.hostId !== hostId || self.creation !== 'ready' || self.role !== 'leader') fail('Only the task\'s worker does this.');
      if (team.status !== 'active') fail('This task is no longer running.');
      return update(team, self, item, this.broker.ports.now());
    });
  }
}
