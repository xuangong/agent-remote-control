import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentSessionTool, AgentSessionToolNamespace } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey, TASK_BRIEF_LIMIT, TASK_DONE_WHEN_LIMIT, TASK_TITLE_LIMIT, type CallForSupportCall, type NativeSessionRef, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { TeamResourceFiles } from './team-resource-files.js';

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
}
type Enablement = { defaultEnabled: boolean; sessions: Map<string, boolean> };
type StatusCall = { roleId: string; requesterMemberId: string; call: CallForSupportCall };

export const WORKER_NAMESPACE = 'agent_remote';
const id = { type: 'string', minLength: 1, maxLength: 256 };
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const fail = (message: string): never => { throw new Error(message); };
const tool = (name: string, description: string, inputSchema: Record<string, unknown>, execute: (args: any) => Promise<unknown>): AgentSessionTool =>
  ({ name, description, inputSchema, execute: async args => JSON.stringify(await execute(args)) });

/** A worker's own Call For Support tools and the enablement that decides where the Controller offers them. */
export class WorkerSupport {
  private enablement: Enablement = { defaultEnabled: false, sessions: new Map() };
  private readonly listeners = new Set<() => void>();
  private readonly resources: TeamResourceFiles;
  private polling = false;
  private tasksOffered = false;
  constructor(private readonly ports: WorkerSupportPorts) {
    this.resources = new TeamResourceFiles(join(ports.stateDirectory, 'support-resources'), call => ports.request(call));
  }
  /** Whether the session is offered the namespace: tasks are on, or the user enabled it for support, explicitly or by a profile's default. */
  enabled(ref: NativeSessionRef): boolean {
    if (!this.ports.available()) return false;
    if (this.ports.tasks?.() === true) return true;
    return this.enablement.sessions.get(nativeSessionRefKey(ref)) ?? this.enablement.defaultEnabled;
  }
  /** Whether a session the Controller is about to create will be offered the namespace: tasks, or a profile's default, can say so yet. */
  enabledByDefault(): boolean { return this.ports.available() && (this.ports.tasks?.() === true || this.enablement.defaultEnabled); }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Reads enablement from the Relay; listeners hear about any change. */
  async refresh(controllerId: string): Promise<void> {
    if (this.polling || !this.ports.available()) return;
    this.polling = true;
    try {
      const value = await this.ports.request({ action: 'support_enablement' }) as { defaultEnabled?: unknown; sessions?: unknown };
      if (!value || typeof value.defaultEnabled !== 'boolean' || !Array.isArray(value.sessions)) throw new Error('Invalid Call For Support enablement.');
      const sessions = new Map<string, boolean>();
      for (const entry of value.sessions as Array<{ providerId?: unknown; nativeSessionId?: unknown; enabled?: unknown }>) {
        if (typeof entry?.providerId !== 'string' || typeof entry.nativeSessionId !== 'string' || typeof entry.enabled !== 'boolean') continue;
        sessions.set(nativeSessionRefKey({ controllerId, providerId: entry.providerId, nativeSessionId: entry.nativeSessionId }), entry.enabled);
      }
      const next = { defaultEnabled: value.defaultEnabled, sessions }, tasks = this.ports.tasks?.() === true;
      const changed = tasks !== this.tasksOffered || next.defaultEnabled !== this.enablement.defaultEnabled || next.sessions.size !== this.enablement.sessions.size
        || [...next.sessions].some(([key, enabled]) => this.enablement.sessions.get(key) !== enabled);
      this.enablement = next; this.tasksOffered = tasks;
      if (changed) for (const listener of this.listeners) { try { listener(); } catch { /* Listeners cannot stop enablement. */ } }
    } finally { this.polling = false; }
  }
  /** The worker's tools, bound to the session that runs them. deferred: found by search rather than listed. */
  namespace(actual: () => NativeSessionRef | undefined, deferred: boolean): AgentSessionToolNamespace {
    const worker = () => actual() ?? fail('Call For Support is not attached to this session yet.');
    const request = async (call: TeamHostCall) => { if (!this.ports.available()) fail('Update the Relay to use Call For Support.'); return this.ports.request(call); };
    const status = async (input: { roleId?: string; callId?: string }) => { const ref = worker(); return request({ action: 'support_status', worker: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, ...input }); };
    const call = async (callId: string) => await status({ callId }) as StatusCall;
    const taskRequest = async (input: TeamHostCall) => { if (this.ports.tasks?.() !== true) fail('Update the Relay to use tasks.'); return this.ports.request(input); };
    const context = object({ commit: { type: 'string', pattern: '^[0-9a-f]{7,64}$' }, base: { type: 'string', pattern: '^[0-9a-f]{7,64}$' },
      files: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 2048 }, maxItems: 64 }, conversation: { type: 'boolean' } }, []);
    const tools = [
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
      tool('create_task', 'Start a task: a separate session on this Host works on it in your working directory while you keep talking with the person. Use it for work that takes more than a few steps, and start one task per independent piece of work. Write a brief that stands alone: the worker sees only the brief, and reads your conversation only if the brief says it is needed. The result arrives later as input labelled [Task … · done] or [Task … · failed]; until then tell the person what you started and keep answering them. Reuse operationId to retry the same task after a lost response.',
        object({ title: { type: 'string', minLength: 1, maxLength: TASK_TITLE_LIMIT }, brief: { type: 'string', minLength: 1, maxLength: TASK_BRIEF_LIMIT },
          done_when: { type: 'string', minLength: 1, maxLength: TASK_DONE_WHEN_LIMIT }, operationId: id }, ['title', 'brief']),
        async args => {
          const ref = worker(), title = await this.ports.title?.(ref).catch(() => undefined);
          return taskRequest({ action: 'create_task', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId, ...(title ? { title: title.slice(0, 256) } : {}) },
            operationId: args.operationId ?? randomUUID(), title: args.title, brief: args.brief, ...(args.done_when ? { doneWhen: args.done_when } : {}) });
        }),
      tool('task_status', 'List the tasks this session started, newest first, with their state (queued, working, done, failed, cancelled) and result; or read one by taskId.',
        object({ taskId: id }, []), args => { const ref = worker(); return taskRequest({ action: 'task_status', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, ...(args.taskId ? { taskId: args.taskId } : {}) }); }),
    ];
    return { name: WORKER_NAMESPACE, description: 'Agent Remote Control: start tasks that other sessions work on in parallel and report back; call for support from other sessions, models and machines (reviews, consultations, tests), and read their reports.',
      ...(deferred ? { deferred: true } : {}), tools };
  }
}
