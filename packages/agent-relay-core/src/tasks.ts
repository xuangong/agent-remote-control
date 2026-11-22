import { createHash, randomUUID } from 'node:crypto';
import { nativeSessionRefKey, TASK_RUNNING_LIMIT, taskBriefText, taskResultText, taskSenderName, taskView, type Team, type TeamHostCall, type TeamMember, type TeamTask, type TaskView } from '@orchardworks/agent-remote-protocol';
import { ACCOUNT_TEAM_LIMIT, assertTeamQueueCapacity, unresolvedTeamDelivery, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
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

/** Finished tasks kept per account; older ones, whose deliveries are settled, are removed. */
export const TASK_FINISHED_KEEP = 200;
const STATUS_LIMIT = 20;
const fail = (message: string): never => { throw new Error(message); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const task = (team: Team): TeamTask => team.task ?? fail('Team is not a task.');
const owner = (team: Team): TeamMember => team.members[1] ?? fail('Task has no owner.');
const finished = (state: TeamTask['state']) => state === 'done' || state === 'failed' || state === 'cancelled';
const sameKey = (resolve: TeamBrokerPorts['resolveSession'], hostId: string, providerId: string, nativeSessionId: string) => {
  try { return nativeSessionRefKey(resolve(hostId, providerId, nativeSessionId)); } catch { return undefined; }
};

export { quoteFrames } from '@orchardworks/agent-remote-protocol';
/** The worker's first input. */
export const briefText = (team: Team): string => { const item = task(team); return taskBriefText({ taskId: team.id, from: team.source.title, title: item.title, brief: item.brief, ...(item.doneWhen ? { doneWhen: item.doneWhen } : {}) }); };
/** The owner's view of a report. */
export const resultText = (team: Team): string => { const item = task(team), result = item.result ?? fail('The task has no result.'); return taskResultText({ taskId: team.id, status: result.status, title: item.title, summary: result.summary }); };

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

const settled = (team: SavedTeam) => ![...team.messages, ...(team.deliveryReceipts ?? [])].some(message => message.status === 'queued' || unresolvedTeamDelivery(message));
/** Removes the oldest finished tasks with settled deliveries beyond the kept number, and makes room for one more Team at the account limit. */
export function pruneTasks(teams: SavedTeam[], reserve = 0): void {
  const view = plain(teams);
  const removable = view.filter(team => team.task && finished(team.task.state) && settled(team)).sort((a, b) => a.task!.updatedAt - b.task!.updatedAt);
  const finishedCount = view.filter(team => team.task && finished(team.task.state)).length;
  let excess = Math.max(finishedCount - TASK_FINISHED_KEEP, view.length + reserve - ACCOUNT_TEAM_LIMIT, 0);
  for (const team of removable) {
    if (excess <= 0) break;
    teams.splice(plain(teams).findIndex(item => item.id === team.id), 1); excess--;
  }
}

/** Task creation, status and reports, on top of the Team broker. */
export class TaskGroups {
  constructor(private readonly broker: TaskBrokerPorts, private readonly ports: TaskPorts) {}
  capable(hostId: string): boolean { return this.ports.capable(hostId); }
  async create(hostId: string, call: CreateCall): Promise<{ taskId: string; state: TaskView['state']; message: string }> {
    this.ports.assertHost(hostId);
    this.broker.ports.assertHost(hostId, call.owner.providerId);
    const resolve = this.broker.ports.resolveSession;
    if (!sameKey(resolve, hostId, call.owner.providerId, call.owner.nativeSessionId)) fail('The owner session is not on this Host.');
    const created = await this.broker.change(teams => {
      const now = this.broker.ports.now();
      const existing = teams.find(team => team.operationId === call.operationId);
      if (existing) {
        const item = existing.task, seat = existing.task && owner(existing);
        if (!item || seat?.nativeSessionId !== call.owner.nativeSessionId || seat.hostId !== hostId || item.title !== call.title || item.brief !== call.brief || item.doneWhen !== call.doneWhen) fail('Task identity has different input.');
        return existing;
      }
      const running = ownerTasks(plain(teams), resolve, hostId, call.owner).filter(team => team.task!.state === 'working').length;
      if (running >= TASK_RUNNING_LIMIT) fail(`This session already has ${running} tasks running. Wait for a result before starting another.`);
      pruneTasks(teams, 1);
      if (plain(teams).length >= ACCOUNT_TEAM_LIMIT) fail('Team capacity reached.');
      const worker: TeamMember = { id: randomUUID(), role: 'leader', hostId, providerId: call.owner.providerId, name: 'Worker', responsibility: call.title,
        creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now };
      const main: TeamMember = { id: randomUUID(), role: 'requester', hostId, providerId: call.owner.providerId, nativeSessionId: call.owner.nativeSessionId,
        name: taskSenderName(call.owner.title), responsibility: 'The main session that owns this task.', creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now };
      const team: SavedTeam = { id: randomUUID(), operationId: call.operationId, revision: 1, title: call.title, status: 'active', members: [worker, main], messages: [],
        source: { hostId, providerId: call.owner.providerId, nativeSessionId: call.owner.nativeSessionId, title: taskSenderName(call.owner.title) },
        task: { title: call.title, brief: call.brief, ...(call.doneWhen ? { doneWhen: call.doneWhen } : {}), state: 'working', createdAt: now, updatedAt: now }, createdAt: now, updatedAt: now };
      const brief = { id: digest(['task-brief', team.id]), from: main.id, to: worker.id, text: briefText(team), status: 'queued' as const, createdAt: now };
      assertTeamQueueCapacity(team, brief);
      team.messages.push(brief);
      teams.push(team);
      return team;
    });
    const team = await this.provision(created.id);
    const view = taskView(team);
    return { taskId: view.taskId, state: view.state,
      message: view.state === 'queued' ? `Task ${view.taskId} is recorded but its worker is not ready${view.worker.error ? `: ${view.worker.error}` : ''}.`
        : `Task ${view.taskId} started. Its result arrives later as input; keep the person informed meanwhile.` };
  }
  /** The owner's seat binds first; the worker starts in the owner's directory. */
  async provision(teamId: string): Promise<Team> {
    const saved = this.broker.ports.read().find(team => team.id === teamId) ?? fail('Task not found.');
    let team = await this.broker.provision(teamId, owner(saved).id);
    if (owner(team).creation !== 'ready') return team;
    team = await this.broker.provision(teamId, team.members[0]!.id);
    return team;
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
      if (item.state !== 'working' || team.status !== 'active') fail('This task is no longer running.');
      item.result = { status: call.status, summary: call.summary, reportedAt: now }; item.state = call.status; item.updatedAt = now;
      const message = { id: digest(['task-result', team.id]), from: self.id, to: owner(team).id, text: resultText(team), status: 'queued' as const, createdAt: now };
      assertTeamQueueCapacity(team, message);
      team.messages.push(message);
      team.revision++; team.updatedAt = now;
      return { taskId: team.id, state: item.state };
    });
  }
}
