import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentSessionTool, AgentSessionToolNamespace } from '@orchardworks/agent-provider-sdk';
import { ASSISTANT_MESSAGE_LIMIT, nativeSessionRefKey, ROOM_MINUTES_LIMIT, TASK_BRIEF_LIMIT, TASK_DONE_WHEN_LIMIT, TASK_SUMMARY_LIMIT, TASK_TITLE_LIMIT, type CallForSupportCall, type NativeSessionRef, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { TeamResourceFiles } from './team-resource-files.js';
import { botInstructions } from './bot-instructions.js';

export interface WorkerSupportPorts {
  request(call: TeamHostCall): Promise<unknown>;
  /** The Relay acknowledged Call For Support. */
  available(): boolean;
  /** The Relay acknowledged tasks, which every session without a role may then use. */
  tasks?(): boolean;
  /** A directory for downloaded support resources. */
  stateDirectory: string;
  /** A session's title, for the group the Relay creates. */
  title?(ref: NativeSessionRef): Promise<string | undefined>;
  /** The commit checked out in a session's working directory, where a worktree task starts. */
  head?(ref: NativeSessionRef): Promise<string>;
  /** The provider keeps a session it starts from writing its working directory. */
  readOnly?(providerId: string): boolean;
}
type Enablement = { defaultEnabled: boolean; sessions: Map<string, boolean>; coordinators: Set<string>; bots: Map<string, string> };
/** Which worker tools a session has: none, Call For Support only, or Call For Support with the task tools of a coordinator. */
export type WorkerTools = 'none' | 'support' | 'tasks';
type StatusCall = { roleId: string; requesterMemberId: string; call: CallForSupportCall };

export const WORKER_NAMESPACE = 'agent_remote';
/** The worker tools a session was given: listed (not deferred) worker namespaces, with or without the task tools. */
export function workerToolsIn(namespaces: readonly AgentSessionToolNamespace[] | undefined): WorkerTools {
  const listed = namespaces?.find(namespace => namespace.name === WORKER_NAMESPACE && !namespace.deferred);
  return !listed ? 'none' : listed.tools.some(item => item.name === 'create_task') ? 'tasks' : 'support';
}
const id = { type: 'string', minLength: 1, maxLength: 256 };
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const fail = (message: string): never => { throw new Error(message); };
const tool = (name: string, description: string, inputSchema: Record<string, unknown>, execute: (args: any) => Promise<unknown>): AgentSessionTool =>
  ({ name, description, inputSchema, execute: async args => JSON.stringify(await execute(args)) });

/** A worker's own Call For Support tools and the enablement that decides where the Controller offers them. */
export class WorkerSupport {
  private enablement: Enablement = { defaultEnabled: false, sessions: new Map(), coordinators: new Set(), bots: new Map() };
  private readonly listeners = new Set<() => void>();
  private readonly resources: TeamResourceFiles;
  private polling = false;
  private tasksOffered = false;
  constructor(private readonly ports: WorkerSupportPorts) {
    this.resources = new TeamResourceFiles(join(ports.stateDirectory, 'support-resources'), call => ports.request(call));
  }
  /** Whether the session is offered the namespace: it is a coordinator's main session, or the user enabled it for support, explicitly or by a profile's default. */
  enabled(ref: NativeSessionRef): boolean { return this.tools(ref) !== 'none'; }
  /** The worker tools the session is offered. */
  tools(ref: NativeSessionRef): WorkerTools {
    if (!this.ports.available()) return 'none';
    const key = nativeSessionRefKey(ref);
    if (this.ports.tasks?.() === true && this.enablement.coordinators.has(key)) return 'tasks';
    return (this.enablement.sessions.get(key) ?? this.enablement.defaultEnabled) ? 'support' : 'none';
  }
  /** The standing instructions of a bot's main session (base instructions and its mission); undefined for a session that is no bot. */
  standing(ref: NativeSessionRef): string | undefined {
    const mission = this.enablement.bots.get(nativeSessionRefKey(ref));
    return mission === undefined ? undefined : botInstructions(mission || undefined);
  }
  /** Whether a session the Controller is about to create will be offered the namespace: only a profile's default can say so yet, since it is nobody's main session. */
  enabledByDefault(): boolean { return this.ports.available() && this.enablement.defaultEnabled; }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Reads enablement from the Relay; listeners hear about any change. */
  async refresh(controllerId: string): Promise<void> {
    if (this.polling || !this.ports.available()) return;
    this.polling = true;
    try {
      const value = await this.ports.request({ action: 'support_enablement' }) as { defaultEnabled?: unknown; sessions?: unknown; coordinators?: unknown; bots?: unknown };
      if (!value || typeof value.defaultEnabled !== 'boolean' || !Array.isArray(value.sessions)) throw new Error('Invalid Call For Support enablement.');
      const sessions = new Map<string, boolean>();
      for (const entry of value.sessions as Array<{ providerId?: unknown; nativeSessionId?: unknown; enabled?: unknown }>) {
        if (typeof entry?.providerId !== 'string' || typeof entry.nativeSessionId !== 'string' || typeof entry.enabled !== 'boolean') continue;
        sessions.set(nativeSessionRefKey({ controllerId, providerId: entry.providerId, nativeSessionId: entry.nativeSessionId }), entry.enabled);
      }
      const bots = new Map<string, string>();
      for (const entry of Array.isArray(value.bots) ? value.bots as Array<{ providerId?: unknown; nativeSessionId?: unknown; mission?: unknown }> : []) {
        if (typeof entry?.providerId === 'string' && typeof entry.nativeSessionId === 'string')
          bots.set(nativeSessionRefKey({ controllerId, providerId: entry.providerId, nativeSessionId: entry.nativeSessionId }), typeof entry.mission === 'string' ? entry.mission : '');
      }
      const coordinators = new Set<string>();
      for (const entry of Array.isArray(value.coordinators) ? value.coordinators as Array<{ providerId?: unknown; nativeSessionId?: unknown }> : []) {
        if (typeof entry?.providerId === 'string' && typeof entry.nativeSessionId === 'string') coordinators.add(nativeSessionRefKey({ controllerId, providerId: entry.providerId, nativeSessionId: entry.nativeSessionId }));
      }
      const next = { defaultEnabled: value.defaultEnabled, sessions, coordinators, bots }, tasks = this.ports.tasks?.() === true;
      const changed = tasks !== this.tasksOffered || next.defaultEnabled !== this.enablement.defaultEnabled || next.sessions.size !== this.enablement.sessions.size
        || [...next.sessions].some(([key, enabled]) => this.enablement.sessions.get(key) !== enabled)
        || next.coordinators.size !== this.enablement.coordinators.size || [...next.coordinators].some(key => !this.enablement.coordinators.has(key))
        || next.bots.size !== this.enablement.bots.size || [...next.bots].some(([key, mission]) => this.enablement.bots.get(key) !== mission);
      this.enablement = next; this.tasksOffered = tasks;
      if (changed) for (const listener of this.listeners) { try { listener(); } catch { /* Listeners cannot stop enablement. */ } }
    } finally { this.polling = false; }
  }
  /**
   * The worker's tools, bound to the session that runs them. deferred: found by search rather than listed. tasks: with the task,
   * assistant and room tools of a coordinator; the Relay refuses them from a session that is not one.
   */
  namespace(actual: () => NativeSessionRef | undefined, deferred: boolean, tasks: boolean): AgentSessionToolNamespace {
    const worker = () => actual() ?? fail('Call For Support is not attached to this session yet.');
    const request = async (call: TeamHostCall) => { if (!this.ports.available()) fail('Update the Relay to use Call For Support.'); return this.ports.request(call); };
    const status = async (input: { roleId?: string; callId?: string }) => { const ref = worker(); return request({ action: 'support_status', worker: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, ...input }); };
    const call = async (callId: string) => await status({ callId }) as StatusCall;
    const taskRequest = async (input: TeamHostCall) => { if (this.ports.tasks?.() !== true) fail('Update the Relay to use tasks.'); return this.ports.request(input); };
    const context = object({ commit: { type: 'string', pattern: '^[0-9a-f]{7,64}$' }, base: { type: 'string', pattern: '^[0-9a-f]{7,64}$' },
      files: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 2048 }, maxItems: 64 }, conversation: { type: 'boolean' } }, []);
    const support = [
      tool('call_for_support', 'Ask for support you cannot give yourself: an independent review, a stronger or different model, another machine or environment. Name a roleId from support_status to follow up with the same role and its context, or a profileId to call this session\'s role for that profile, starting one if it has none; either reopens an archived role, and with a profileId fresh: true starts a new role instead. Give the task and the deliverable. The coordinator runs on your Host in your working directory and reads your files in place, uncommitted changes included, so do not make snapshot commits or copies for it; say where the change is when it is outside your working directory, such as in a worktree. Give a commit only to pin the code reviewed, or when supporters work in their own worktree or on another machine. Calls are asynchronous: the report arrives later as input, so keep working. Reports are advice; you stay the owner of your task and workspace.',
        object({ roleId: id, profileId: id, task: { type: 'string', minLength: 1, maxLength: 12000 }, context, deliverable: { type: 'string', enum: ['findings', 'answer', 'test_report', 'patch'] },
          followUpOf: id, fresh: { type: 'boolean' }, operationId: id }, ['task', 'deliverable']),
        async args => {
          const ref = worker(), title = await this.ports.title?.(ref).catch(() => undefined);
          return request({ action: 'call_for_support', worker: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId, ...(title ? { title: title.slice(0, 256) } : {}) },
            operationId: args.operationId ?? randomUUID(), task: args.task, deliverable: args.deliverable, ...(args.context ? { context: args.context } : {}),
            ...(args.roleId ? { roleId: args.roleId } : {}), ...(args.profileId ? { profileId: args.profileId } : {}), ...(args.followUpOf ? { followUpOf: args.followUpOf } : {}), ...(args.fresh ? { fresh: true } : {}) } as TeamHostCall);
        }),
      tool('support_status', 'List the support profiles enabled for this session and its support roles with their open calls and last report; or read one call by callId.',
        object({ roleId: id, callId: id }, []), args => status({ ...(args.roleId ? { roleId: args.roleId } : {}), ...(args.callId ? { callId: args.callId } : {}) })),
      tool('read_support_report', 'Read a delivered support report in full, or one finding with its evidence.',
        object({ callId: id, findingId: { type: 'string', minLength: 1, maxLength: 64 } }, ['callId']), async args => {
          const { roleId, call: found } = await call(args.callId);
          if (!found.report) return { callId: found.id, roleId, status: found.status, message: 'This call has no report yet.' };
          if (!args.findingId) return { callId: found.id, roleId, status: found.status, report: found.report };
          return { callId: found.id, roleId, finding: found.report.findings.find(finding => finding.id === args.findingId) ?? fail('Finding not found in this report.') };
        }),
      tool('download_support_resource', 'Download a resource attached to a support report, such as a patch or a log, to a verified local file. It is never applied or executed: read it, then decide.',
        object({ callId: id, resourceId: id, outputDirectory: { type: 'string', minLength: 1, maxLength: 4096 } }, ['callId', 'resourceId']), async args => {
          const { roleId, requesterMemberId, call: found } = await call(args.callId);
          if (!found.report?.resources?.some(resource => resource.resourceId === args.resourceId)) fail('The resource is not attached to this report.');
          return this.resources.download(roleId, requesterMemberId, args.resourceId, args.outputDirectory);
        }),
    ];
    const coordination = [
      tool('create_task', 'Start a task: a separate session on this Host works on it while you keep talking with the person. Use it for work that takes more than a few steps, and start one task per independent piece of work. Write a brief that stands alone: the worker sees only the brief, and reads your conversation only if the brief says it is needed. workspace: same (default) works in your working directory alongside you; read_only investigates it without changing it; worktree works in its own git worktree at your current commit (uncommitted changes are not in it) and returns its changes as a patch. provider and model choose another agent or model for the worker. The result arrives later as input labelled [Task … · done] or [Task … · failed]; until then tell the person what you started and keep answering them. Reuse operationId to retry the same task after a lost response.',
        object({ title: { type: 'string', minLength: 1, maxLength: TASK_TITLE_LIMIT }, brief: { type: 'string', minLength: 1, maxLength: TASK_BRIEF_LIMIT },
          done_when: { type: 'string', minLength: 1, maxLength: TASK_DONE_WHEN_LIMIT }, workspace: { type: 'string', enum: ['same', 'read_only', 'worktree'] }, provider: id,
          model: { type: 'string', minLength: 1, maxLength: 256 }, operationId: id }, ['title', 'brief']),
        async args => {
          const ref = worker(), title = await this.ports.title?.(ref).catch(() => undefined);
          const workspace = args.workspace as 'same' | 'read_only' | 'worktree' | undefined;
          if (workspace === 'read_only' && !this.ports.readOnly?.(args.provider ?? ref.providerId)) fail('This agent cannot work read-only here; use workspace worktree or same.');
          const commit = workspace === 'worktree' ? await (this.ports.head ?? (() => fail('Worktree tasks are not available on this Host.')))(ref) : undefined;
          return taskRequest({ action: 'create_task', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId, ...(title ? { title: title.slice(0, 256) } : {}) },
            operationId: args.operationId ?? randomUUID(), title: args.title, brief: args.brief, ...(args.done_when ? { doneWhen: args.done_when } : {}),
            ...(workspace && workspace !== 'same' ? { workspace } : {}), ...(commit ? { commit } : {}), ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}) });
        }),
      tool('task_status', 'List the tasks this session started, newest first, with their state (queued, working, needs_input, done, failed, cancelled), what a waiting task waits for, and the result; or read one by taskId.',
        object({ taskId: id }, []), args => { const ref = worker(); return taskRequest({ action: 'task_status', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, ...(args.taskId ? { taskId: args.taskId } : {}) }); }),
      tool('list_assistants', 'List the other assistants of this account that you can message, with their id and name.',
        object({}, []), () => { const ref = worker(); return taskRequest({ action: 'list_assistants', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId } }); }),
      tool('message_assistant', 'Send another assistant of this account a message: a question, a request or what it should know. It arrives when that assistant is between turns, labelled with your name; its answer arrives later as input labelled [Message from …]. Answer a message you received with reply_to set to its id. Carry only what the other assistant needs. Reuse operationId to retry the same message.',
        object({ to: { type: 'string', minLength: 1, maxLength: 300 }, text: { type: 'string', minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT }, reply_to: { type: 'string', pattern: '^m[0-9a-f]{12}$' }, operationId: id }, ['to', 'text']),
        args => { const ref = worker();
          return taskRequest({ action: 'message_assistant', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, to: args.to, text: args.text, operationId: args.operationId ?? randomUUID(),
            ...(args.reply_to ? { replyTo: args.reply_to } : {}) }); }),
      tool('open_room', 'Open a room: a conversation of you and other assistants of this account (by name) about a topic, for a set number of minutes. The topic is your first message; the room then asks one member at a time to speak, with the messages it has not seen, and you are asked again when there is something new. The person sees the room and may write in it.',
        object({ name: { type: 'string', minLength: 1, maxLength: 120 }, topic: { type: 'string', minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT },
          members: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 300 }, minItems: 1, maxItems: 7 }, minutes: { type: 'integer', minimum: 1, maximum: ROOM_MINUTES_LIMIT }, operationId: id }, ['name', 'topic', 'members', 'minutes']),
        args => { const ref = worker();
          return taskRequest({ action: 'open_room', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, operationId: args.operationId ?? randomUUID(), name: args.name, topic: args.topic,
            members: args.members, minutes: args.minutes }); }),
      tool('room_say', 'Speak in a room when it is your turn (input labelled [Room … · your turn]). Say done: true with the result when the room has reached what it was opened for.',
        object({ room: id, text: { type: 'string', minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT }, done: { type: 'boolean' } }, ['room', 'text']),
        args => { const ref = worker();
          return taskRequest({ action: 'room_say', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, roomId: args.room, text: args.text, ...(args.done === true ? { done: true } : {}) }); }),
      tool('room_pass', 'Pass your turn in a room when you have nothing to add.',
        object({ room: id }, ['room']), args => { const ref = worker(); return taskRequest({ action: 'room_pass', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, roomId: args.room }); }),
      tool('message_task', 'Send input to the worker of a running task: an answer to its question, a correction or more detail. It arrives when the worker is between turns.',
        object({ taskId: id, text: { type: 'string', minLength: 1, maxLength: TASK_BRIEF_LIMIT }, operationId: id }, ['taskId', 'text']), args => { const ref = worker();
          return taskRequest({ action: 'message_task', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, taskId: args.taskId, operationId: args.operationId ?? randomUUID(), text: args.text }); }),
      tool('cancel_task', 'Stop a running task: its worker stops and gets no more input. Its session stays readable.',
        object({ taskId: id }, ['taskId']), args => { const ref = worker(); return taskRequest({ action: 'cancel_task', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, taskId: args.taskId }); }),
      tool('mark_task_done', 'Take a running task as done without its report, for example when the person says it is enough; summary records why.',
        object({ taskId: id, summary: { type: 'string', minLength: 1, maxLength: TASK_SUMMARY_LIMIT } }, ['taskId']), args => { const ref = worker();
          return taskRequest({ action: 'mark_task_done', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, taskId: args.taskId, ...(args.summary ? { summary: args.summary } : {}) }); }),
    ];
    const supportDescription = 'call for support from other sessions, models and machines (reviews, consultations, tests), and read their reports.';
    return { name: WORKER_NAMESPACE, description: tasks ? `Agent Remote Control: start tasks that other sessions work on in parallel and report back; message the account's other assistants; ${supportDescription}` : `Agent Remote Control: ${supportDescription}`,
      ...(deferred ? { deferred: true } : {}), tools: tasks ? [...support, ...coordination] : support };
  }
}
