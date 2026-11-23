import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentSessionTool, AgentSessionToolNamespace } from '@orchardworks/agent-provider-sdk';
import { ASSISTANT_MESSAGE_LIMIT, BOT_MESSAGE_LIMIT, nativeSessionRefKey, ROOM_MINUTES_LIMIT, TASK_BRIEF_LIMIT, TASK_TITLE_LIMIT, type CallForSupportCall, type NativeSessionRef, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
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
  /** A bounded page of a session's recent conversation on this Host. */
  read?(ref: NativeSessionRef, before?: { epoch: string; seq: number }): Promise<unknown>;
  /** A worktree bot's patch, saved on this Host, as the line its organizer reads; undefined for any other bot. */
  patch?(ref: NativeSessionRef): Promise<string | undefined>;
}
type Enablement = { defaultEnabled: boolean; sessions: Map<string, boolean>; bots: Map<string, string> };
/** Which worker tools a session has: none, Call For Support only, or Call For Support with the task tools every bot has. */
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
  private enablement: Enablement = { defaultEnabled: false, sessions: new Map(), bots: new Map() };
  private readonly listeners = new Set<() => void>();
  private readonly resources: TeamResourceFiles;
  private polling = false;
  private loadedOnce = false;
  private polled?: Promise<void>;
  private tasksOffered = false;
  constructor(private readonly ports: WorkerSupportPorts) {
    this.resources = new TeamResourceFiles(join(ports.stateDirectory, 'support-resources'), call => ports.request(call));
  }
  /** Whether the session is offered the namespace: it is a bot's main session, or the user enabled it for support, explicitly or by a profile's default. */
  enabled(ref: NativeSessionRef): boolean { return this.tools(ref) !== 'none'; }
  /** The worker tools the session is offered. */
  tools(ref: NativeSessionRef): WorkerTools {
    if (!this.ports.available()) return 'none';
    const key = nativeSessionRefKey(ref);
    if (this.ports.tasks?.() === true && this.enablement.bots.has(key)) return 'tasks';
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
  /**
   * Waits, at most `limitMs`, until enablement has been read once since the Controller started, so a session that opens right after a
   * restart still gets its standing instructions and tools. A Relay that does not answer in time leaves the session as it is.
   */
  async loaded(controllerId: string, limitMs = 3000): Promise<void> {
    if (this.loadedOnce || !this.ports.available()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([(this.polled ?? this.refresh(controllerId)).catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, limitMs); })]);
    clearTimeout(timer);
  }
  /** Reads enablement from the Relay; listeners hear about any change. */
  async refresh(controllerId: string): Promise<void> {
    if (this.polling || !this.ports.available()) return this.polled;
    this.polling = true;
    this.polled = this.read(controllerId).finally(() => { this.polling = false; this.polled = undefined; });
    return this.polled;
  }
  private async read(controllerId: string): Promise<void> {
    const value = await this.ports.request({ action: 'support_enablement' }) as { defaultEnabled?: unknown; sessions?: unknown; bots?: unknown };
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
    const next = { defaultEnabled: value.defaultEnabled, sessions, bots }, tasks = this.ports.tasks?.() === true;
    const changed = tasks !== this.tasksOffered || next.defaultEnabled !== this.enablement.defaultEnabled || next.sessions.size !== this.enablement.sessions.size
      || [...next.sessions].some(([key, enabled]) => this.enablement.sessions.get(key) !== enabled)
      || next.bots.size !== this.enablement.bots.size || [...next.bots].some(([key, mission]) => this.enablement.bots.get(key) !== mission);
    this.enablement = next; this.tasksOffered = tasks; this.loadedOnce = true;
    if (changed) for (const listener of this.listeners) { try { listener(); } catch { /* Listeners cannot stop enablement. */ } }
  }
  /**
   * The worker's tools, bound to the session that runs them. deferred: found by search rather than listed. tasks: with the task,
   * assistant and room tools every bot has; the Relay refuses them from a session that is no bot.
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
    const caller = () => { const ref = worker(); return { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }; };
    const coordination = [
      tool('create_bot', 'Start a bot. lifetime temporary (default) is for one piece of work: it runs in parallel on this Host in a session of its own, while you keep talking with the person, and reports back to you as input labelled [Task … · done] or [Task … · failed], or asks you [Task … · question]. Give it a short name and a mission that stands alone: it sees only the mission and its first message, and reads your conversation only if the mission says so. workspace: same (default) works in your working directory alongside you; read_only investigates it without changing it; worktree works in its own git worktree at your current commit and returns its changes as a patch. provider and model choose another agent or model. lifetime standing creates a bot that stays, with its own place in your group and in the person\'s chats, for a role your work keeps needing (a reviewer, a tester); it reads its mission and reports in, and you work with it by message. Then tell the person what you started. Reuse operationId to retry after a lost response.',
        object({ name: { type: 'string', minLength: 1, maxLength: TASK_TITLE_LIMIT }, mission: { type: 'string', minLength: 1, maxLength: TASK_BRIEF_LIMIT },
          message: { type: 'string', minLength: 1, maxLength: BOT_MESSAGE_LIMIT }, lifetime: { type: 'string', enum: ['temporary', 'standing'] }, workspace: { type: 'string', enum: ['same', 'read_only', 'worktree'] }, provider: id,
          model: { type: 'string', minLength: 1, maxLength: 256 }, operationId: id }, ['name', 'mission']),
        async args => {
          const ref = worker(), title = await this.ports.title?.(ref).catch(() => undefined);
          const workspace = args.workspace as 'same' | 'read_only' | 'worktree' | undefined;
          if (workspace === 'read_only' && !this.ports.readOnly?.(args.provider ?? ref.providerId)) fail('This agent cannot work read-only here; use workspace worktree or same.');
          const commit = workspace === 'worktree' ? await (this.ports.head ?? (() => fail('Worktree bots are not available on this Host.')))(ref) : undefined;
          return taskRequest({ action: 'create_bot', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId, ...(title ? { title: title.slice(0, 256) } : {}) },
            operationId: args.operationId ?? randomUUID(), name: args.name, mission: args.mission, lifetime: args.lifetime ?? 'temporary', ...(args.message ? { message: args.message } : {}),
            ...(workspace && workspace !== 'same' ? { workspace } : {}), ...(commit ? { commit } : {}), ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}) });
        }),
      tool('message', 'Send a message to another bot, in your own words and at most 300 characters: a bot you organize, your organizer (to: "organizer"), or any bot from list_bots, by name or id. When you write to your organizer, status says what it is: progress, done or failed (your result, once), or needs_input (you wait for its answer; then end your turn). The details stay where they are: the receiver reads them with read_bot when it needs them. Answer a message another bot sent you with reply_to set to its id. It arrives between the receiver\'s turns. Reuse operationId to retry.',
        object({ to: { type: 'string', minLength: 1, maxLength: 300 }, text: { type: 'string', minLength: 1, maxLength: BOT_MESSAGE_LIMIT }, status: { type: 'string', enum: ['progress', 'done', 'failed', 'needs_input'] },
          reply_to: { type: 'string', pattern: '^m[0-9a-f]{12}$' }, operationId: id }, ['to', 'text']),
        async args => {
          // A worktree bot's result carries the path of its patch, saved on this Host where its organizer works.
          const patch = args.status === 'done' || args.status === 'failed' ? await this.ports.patch?.(worker()) : undefined;
          return taskRequest({ action: 'bot_message', owner: caller(), operationId: args.operationId ?? randomUUID(), to: args.to, text: args.text, ...(patch ? { patch } : {}),
            ...(args.status ? { status: args.status } : {}), ...(args.reply_to ? { replyTo: args.reply_to } : {}) });
        }),
      tool('list_bots', 'List the bots you can message: the bots you organize with their status, your organizer if you have one, and the standing bots of this account with their missions.',
        object({}, []), () => taskRequest({ action: 'list_bots', owner: caller() })),
      tool('read_bot', 'Read a bounded page of the recent conversation of a bot you organize, to see what it did without asking it. Pass before from a previous page to read further back.',
        object({ bot: { type: 'string', minLength: 1, maxLength: 300 }, before: { type: 'object', properties: { epoch: { type: 'string' }, seq: { type: 'integer' } }, required: ['epoch', 'seq'], additionalProperties: false } }, ['bot']),
        async args => {
          const where = await taskRequest({ action: 'bot_session', owner: caller(), bot: args.bot }) as { providerId: string; nativeSessionId: string };
          return (this.ports.read ?? (() => fail('Reading bots is not available on this Host.')))({ ...worker(), providerId: where.providerId, nativeSessionId: where.nativeSessionId }, args.before);
        }),
      tool('stop_bot', 'Stop a bot you organize: its running turn stops and it gets no more input. Its conversation stays readable.',
        object({ bot: { type: 'string', minLength: 1, maxLength: 300 } }, ['bot']), args => taskRequest({ action: 'stop_bot', owner: caller(), bot: args.bot })),
      tool('retire_bot', 'Retire a bot you organize when its work is no longer needed, taking what it has done as its result.',
        object({ bot: { type: 'string', minLength: 1, maxLength: 300 } }, ['bot']), args => taskRequest({ action: 'retire_bot', owner: caller(), bot: args.bot })),
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
    ];
    const supportDescription = 'call for support from other sessions, models and machines (reviews, consultations, tests), and read their reports.';
    return { name: WORKER_NAMESPACE, description: tasks ? `Agent Remote Control: start bots that work in parallel and report back, message the account's other bots, read and stop the bots you organize; ${supportDescription}` : `Agent Remote Control: ${supportDescription}`,
      ...(deferred ? { deferred: true } : {}), tools: tasks ? [...support, ...coordination] : support };
  }
}
