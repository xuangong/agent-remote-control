import { TeamResourceFiles } from './team-resource-files.js';
import { teamInbox, teamMemberUpdate } from './team-inbox.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentOperationRejectedError, bindAgentSessionTools, type AgentInputAcceptance, type AgentSessionExtensions, type AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import type { SessionExecutionRouting } from './session-succession-service.js';
import type { RoleSuccessionDecision, SessionRole } from './session-role-succession.js';
import type { SessionCreation } from './role-session-creation.js';
import { coordinatorInstructions, coordinatorTools, locationInstructions, supporterInstructions } from './call-for-support-roles.js';
import { askOwnerTool, reportTaskTool, TASK_WORKER_NAMESPACE, taskWorkerInstructions } from './task-roles.js';
import { collectPatch, createBundle, fetchBundle, prepareWorktree, removeWorktree, repositoryRoot, worktreePath } from './call-for-support-workspaces.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { accountUsage, type SupportUsage } from './call-for-support-usage.js';
import { tmpdir } from 'node:os';
import { isNativeSessionRef, joinTaskInputs, nativeSessionRefKey, parseTaskInputs, TASK_SUMMARY_LIMIT, TASK_TOLD_LIMIT, type NativeSessionRef, isTeam, isTeamSeat, sessionOperationAvailability, type Team, type TeamHostCall, type TeamMember, type TeamMessage, type TeamSeat } from '@orchardworks/agent-remote-protocol';
import { OperationCacheError, type AgentManagerEvent, type RemoteHostSessionLease, type SessionWireOperationExecutor } from '@orchardworks/agent-session-runtime';

export interface TeamRuntimeAccess {
  controllerId: string;
  /** Role routing: a seat follows every committed succession of its session, including one to another provider. */
  sessionRouting: SessionExecutionRouting;
  /** The Relay routes Team recipients across a generic succession of their session. */
  genericSuccession?(): boolean;
  /** The Relay sends this Controller Call For Support groups. */
  callForSupport?(): boolean;
  /** The Relay sends this Controller tasks. */
  tasks?(): boolean;
  /** The provider takes tool namespaces, whose tools the Host governs and the CLI runs without asking. */
  toolNamespaces?(providerId: string): boolean;
  /** Providers that run Team tools and enforce read-only sessions natively. */
  readOnlyProviders?(): string[];
  available(): boolean;
  supportedProviders(): string[];
  create(provider: string, creation: SessionCreation, extensions: AgentSessionExtensions): Promise<string>;
  acquire(provider: string, sessionId: string): Promise<RemoteHostSessionLease>;
  execute: SessionWireOperationExecutor;
}
interface LocalSeat { seat: TeamSeat; creation: 'dispatching' | 'ready' | 'unknown';
  /** A supporter's own worktree, removed once its creation failed, the supporter is released or its Team archives. */
  worktree?: { root: string; path: string; removed?: true };
  /** A coordinator's or supporter's usage, and what the Relay last accepted of it. */
  usage?: SupportUsage & { reported?: { tokens: number; costUsd?: number; at: number } };
  receipts: Record<string, { text: string; status: 'dispatching' | 'accepted' | 'rejected' | 'unknown'; error?: string; acceptance?: AgentInputAcceptance['disposition']; resolvedTarget?: NativeSessionRef }> }
/** One message to deliver, with the seat it reaches and its Team. */
interface Delivery { record: LocalSeat; team: Team; message: TeamMessage }
/** A main session reads what waits on it before the rest. */
/** At idle a main session reads what waits on it first, then other task updates, then other assistants' messages. */
const taskUpdatePriority = (message: TeamMessage) => /^\[Task \S+ · (question|needs the person) · /.test(message.text) ? 0 : message.text.startsWith('[Message from ') ? 2 : 1;
/** A task Team missing from the poll this long was removed by the Relay. */
const TASK_MISSING_FORGET_MS = 10 * 60_000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Team operation failed.').slice(0, 2048);
function operationId(value: string) {
  const hex = createHash('sha256').update(value).digest('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
/** A pending native interaction in a session, in a few words, or undefined. */
function pendingInteraction(lease: RemoteHostSessionLease): string | undefined {
  const request = lease.agent.snapshot().payload.pendingInteractions[0] as { summary?: string; title?: string; message?: string; detail?: { command?: string; filePath?: string } } | undefined;
  if (!request) return undefined;
  const what = request.detail?.command ?? request.detail?.filePath;
  const words = [request.summary || request.title || request.message || 'It waits for the person to answer a request.', what].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return words.length > TASK_TOLD_LIMIT ? `${words.slice(0, TASK_TOLD_LIMIT - 1)}…` : words;
}
function idle(lease: RemoteHostSessionLease): boolean {
  const state = lease.agent.snapshot().payload;
  return state.status === 'idle' && state.activeTurn === null && !state.pendingInteractions.length && sessionOperationAvailability(state, 'send_message').allowed;
}
export type TeamDelivery = 'immediate' | 'next_turn';
function deliveryAllowed(lease: RemoteHostSessionLease, delivery: TeamDelivery): boolean {
  const state = lease.agent.snapshot().payload;
  const readyIdle = state.status === 'idle' && state.activeTurn === null && !state.pendingInteractions.length;
  const active = state.activeTurn !== null && (state.status === 'running' || state.status === 'waiting');
  if (!readyIdle && !active) return false;
  if (!sessionOperationAvailability(state, delivery === 'next_turn' ? 'queue_message' : 'send_message').allowed) return false;
  return delivery === 'next_turn' || readyIdle || sessionOperationAvailability(state, 'steer').allowed;
}
/**
 * steer: input may join a running turn. A worker's support reports never do; they wait for its next turn.
 * queue: input may wait in the CLI's own next-turn queue. A task's input never does: that queue is ordered with the person's
 * queued messages and the Host cannot withdraw from it, so task input waits here until the session is idle.
 */
export function availableDelivery(lease: RemoteHostSessionLease, steer = true, queue = true): TeamDelivery | undefined {
  if (deliveryAllowed(lease, 'immediate') && (steer || lease.agent.snapshot().payload.activeTurn === null)) return 'immediate';
  if (queue && deliveryAllowed(lease, 'next_turn')) return 'next_turn';
}

/** Local native bindings and delivery evidence outlive browser and transport connections. */
export class TeamRuntime implements SessionRole {
  readonly ready: Promise<void>;
  private records: LocalSeat[] = [];
  private persistence: Promise<unknown> = Promise.resolve();
  private creations = new Map<string, Promise<TeamMember>>();
  private leases = new Map<string, { target: NativeSessionRef; lease: RemoteHostSessionLease; unsubscribe?: () => void }>();
  private readonly resourceFiles: TeamResourceFiles;
  private ticking = false;
  private closed = false;
  /** Recipients with a claim request in flight, before its receipt is durable. */
  private readonly claiming = new Map<string, number>();
  /** When to ask again about a support group missing from the poll, which omits archived groups. */
  private readonly groupChecks = new Map<string, number>();
  /** When each task Team was first missing from the poll. */
  private readonly missingTasks = new Map<string, number>();
  /** Counts seat bindings, so a group restored while its archive was being confirmed keeps its new seats. */
  private bindings = 0;
  private readonly boundAt = new Map<string, number>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly directory: string, private readonly access: TeamRuntimeAccess, private readonly request: (call: TeamHostCall) => Promise<unknown>, tickMs = 3000) {
    this.resourceFiles = new TeamResourceFiles(directory, request);
    this.ready = this.restore();
    void this.ready.catch(() => undefined);
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, tickMs); this.timer.unref?.();
  }
  private async restore() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.records = JSON.parse(await readFile(join(this.directory, 'seats.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!Array.isArray(this.records) || this.records.length > 384 || this.records.some(record => !record || !isTeamSeat(record.seat) || record.creation === 'ready' && !record.seat.member.nativeSessionId || !record.receipts || typeof record.receipts !== 'object' || Array.isArray(record.receipts) || Object.values(record.receipts).some(receipt => !receipt || typeof receipt.text !== 'string' || !['dispatching','accepted','rejected','unknown'].includes(receipt.status) || receipt.acceptance !== undefined && !['started','queued','handled'].includes(receipt.acceptance) || receipt.resolvedTarget !== undefined && (!isNativeSessionRef(receipt.resolvedTarget) || receipt.resolvedTarget.controllerId !== this.access.controllerId)) || !['dispatching','ready','unknown'].includes(record.creation))) throw new Error('Invalid saved Team bindings.');
    for (const record of this.records) {
      if (record.creation === 'dispatching') record.creation = 'unknown';
      for (const receipt of Object.values(record.receipts)) if (receipt.status === 'dispatching') { receipt.status = 'unknown'; receipt.error = 'Controller restarted after dispatch began. Inspect the session before resolving.'; }
    }
  }
  private async save() {
    const json = JSON.stringify(this.records);
    const pending = this.persistence.then(async () => {
      const temp = join(this.directory, `${randomUUID()}.tmp`), file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
      await rename(temp, join(this.directory, 'seats.json'));
    });
    this.persistence = pending;
    // A failed durable write prevents any subsequent effects in this runtime.
    await pending;
  }
  private anchor(seat: TeamSeat): NativeSessionRef {
    if (!seat.member.nativeSessionId) throw new Error('Team recipient is not attached.');
    return { controllerId: this.access.controllerId, providerId: seat.member.providerId, nativeSessionId: seat.member.nativeSessionId };
  }
  hasUnsettledRecipient(target: NativeSessionRef): boolean {
    if (this.claiming.has(nativeSessionRefKey(target))) return true;
    return this.records.some(record => Object.values(record.receipts).some(receipt => {
      if (!['dispatching', 'unknown'].includes(receipt.status) && !(receipt.status === 'accepted' && !['started', 'handled'].includes(receipt.acceptance ?? ''))) return false;
      if (receipt.resolvedTarget) return nativeSessionRefKey(receipt.resolvedTarget) === nativeSessionRefKey(target);
      if (target.controllerId !== this.access.controllerId) return false;
      try { return nativeSessionRefKey(this.access.sessionRouting.resolve(this.anchor(record.seat)).target) === nativeSessionRefKey(this.access.sessionRouting.resolve(target).target); }
      catch { return true; }
    }));
  }
  async extensions(holder: NativeSessionRef, actual: () => NativeSessionRef | undefined = () => holder): Promise<AgentSessionExtensions | undefined> {
    await this.ready;
    // Before a successor's commit its source holds the seat; afterwards, or on restoration, the successor already does.
    const record = this.seatHeldBy([holder, actual()]);
    return record ? this.tools(record.seat, actual) : undefined;
  }
  async genericSuccession(holder: NativeSessionRef, targetProviderId: string): Promise<RoleSuccessionDecision | undefined> {
    await this.ready;
    const record = this.seatHeldBy([holder]);
    if (!record) return undefined;
    if (this.access.genericSuccession?.() !== true) return { allowed: false, reason: 'Update the Relay to hand off Team members.' };
    if (!this.access.supportedProviders().includes(targetProviderId)) return { allowed: false, reason: 'This provider cannot run Team tools on this Host.' };
    if (record.seat.member.access === 'read_only' && !(this.access.readOnlyProviders?.() ?? []).includes(targetProviderId)) return { allowed: false, reason: 'This provider cannot keep this session read-only.' };
    return { allowed: true };
  }
  private seatHeldBy(recipients: ReadonlyArray<NativeSessionRef | undefined>): LocalSeat | undefined {
    const keys = new Set(recipients.filter((ref): ref is NativeSessionRef => !!ref).map(nativeSessionRefKey));
    const records = this.records.filter(item => {
      // A worker's seat in a support group carries no Team tools; the worker keeps its own role.
      if (item.creation !== 'ready' || item.seat.member.role === 'requester') return false;
      try { return keys.has(nativeSessionRefKey(this.access.sessionRouting.resolve(this.anchor(item.seat)).target)); } catch { return false; }
    });
    if (records.length > 1) throw new Error('Team recipient has ambiguous role anchors.');
    return records[0];
  }
  create(seat: TeamSeat): Promise<TeamMember> {
    const key = `${seat.teamId}:${seat.member.id}`, pending = this.creations.get(key); if (pending) return pending;
    const run = this.createOnce(seat).finally(() => this.creations.delete(key)); this.creations.set(key, run); return run;
  }
  private async createOnce(seat: TeamSeat): Promise<TeamMember> {
    await this.ready;
    if (!isTeamSeat(seat) || !this.access.available() || seat.member.role !== 'requester' && !this.access.supportedProviders().includes(seat.member.providerId)) throw new Error('Provider does not support Team tools on this Host.');
    if (seat.task || seat.link ? this.access.tasks?.() !== true : (seat.callForSupport || seat.member.role === 'requester') && this.access.callForSupport?.() !== true)
      throw new Error(seat.task ? 'Update the Relay to use tasks.' : 'Update the Relay to use Call For Support.');
    const existing = this.records.find(item => item.seat.teamId === seat.teamId && item.seat.member.id === seat.member.id);
    if (existing) {
      const previous = existing.seat;
      if (previous.member.providerId !== seat.member.providerId || previous.member.hostId !== seat.member.hostId || previous.member.role !== seat.member.role || JSON.stringify(previous.source) !== JSON.stringify(seat.source)) throw new Error('Team slot identity changed.');
      if (existing.creation !== 'ready') throw new Error('Native creation outcome is unknown. Inspect the Host and abandon this slot before creating another.');
      this.boundAt.set(seat.teamId, ++this.bindings);
      return existing.seat.member;
    }
    if (this.records.length >= 384) throw new Error('Local Team session capacity reached.');
    seat = structuredClone(seat);
    this.boundAt.set(seat.teamId, ++this.bindings);
    if (seat.member.role === 'requester') return this.bindWorker(seat);
    // A restored group's coordinator resumes its own session, with the context it built; a new one starts only if that session is gone.
    if (seat.callForSupport && seat.member.nativeSessionId) {
      const resumed = await this.resume(seat);
      if (resumed) return resumed;
      delete seat.member.nativeSessionId;
    }
    if (seat.member.role === 'leader') {
      const source = await this.access.acquire(seat.source.providerId, seat.source.nativeSessionId);
      try { seat.member.cwd = source.agent.snapshot().payload.runtimeInfo.cwd; } finally { source.release(); }
      if (!seat.member.cwd) throw new Error('Source working directory is unavailable.');
    }
    let worktree: LocalSeat['worktree'];
    const workspace = seat.member.workspace;
    if (workspace?.kind === 'worktree' || workspace?.kind === 'remote') {
      if (!seat.member.cwd) throw new Error('The supporter\'s repository is unknown.');
      const repository = workspace.kind === 'remote' ? workspace.repository : seat.member.cwd;
      try {
        // A remote supporter's repository first receives the commit from the bundle the worker's Host uploaded.
        if (workspace.kind === 'remote') {
          if (!workspace.bundle) throw new Error('The support bundle is missing.');
          const bundle = await this.resourceFiles.download(seat.teamId, seat.member.id, workspace.bundle);
          try { await fetchBundle(workspace.repository, bundle.localPath, seat.teamId, seat.member.id); } finally { await rm(bundle.localPath, { force: true }); }
        }
        const prepared = await prepareWorktree(repository, seat.teamId, seat.member.id, workspace.commit);
        seat.member.cwd = prepared.cwd; worktree = { root: prepared.root, path: prepared.worktree };
      } catch (error) {
        // Nothing records this member yet, so what its preparation left (a fetched ref, a worktree) is removed now.
        await repositoryRoot(repository).then(root => removeWorktree(root, worktreePath(root, seat.teamId, seat.member.id))).catch(() => undefined);
        throw error;
      }
    }
    const record: LocalSeat = { seat, creation: 'dispatching', receipts: Object.create(null), ...(worktree ? { worktree } : {}) };
    this.records.push(record); await this.save();
    try {
      let actual: NativeSessionRef | undefined;
      seat.member.nativeSessionId = await this.access.create(seat.member.providerId, { cwd: seat.member.cwd, model: seat.member.model, reasoningEffort: seat.member.reasoningEffort }, this.tools(seat, () => actual));
      actual = this.anchor(seat);
      record.creation = 'ready'; seat.member.creation = 'ready'; seat.member.activity = 'unknown'; await this.save(); return seat.member;
    } catch (error) {
      record.creation = 'unknown'; seat.member.creation = 'unknown'; await this.save();
      // A seat whose creation outcome is unknown is never created again, so its worktree is removed now.
      await this.removeSeatWorktree(record);
      throw error;
    }
  }
  /** A worktree task's summary with the path of its patch appended; the summary alone when the worktree changed nothing. */
  private async withPatch(seat: TeamSeat, summary: string): Promise<string> {
    const record = this.records.find(item => item.seat.teamId === seat.teamId && item.seat.member.id === seat.member.id), workspace = seat.member.workspace;
    if (!record?.worktree || record.worktree.removed || workspace?.kind !== 'worktree') throw new Error('This task\'s worktree is not on this Host.');
    const patch = await collectPatch(record.worktree.path, workspace.commit);
    if (!patch) return summary;
    const directory = join(this.directory, 'task-patches'), file = join(directory, `${seat.teamId}.patch`);
    await mkdir(directory, { recursive: true }); await writeFile(file, patch);
    const line = `\n\nPatch of the worktree's changes against ${workspace.commit.slice(0, 12)} (apply with git apply): ${file}`;
    return summary.slice(0, TASK_SUMMARY_LIMIT - line.length) + line;
  }
  /** Removes a seat's worktree once; a failure is retried on a later tick. */
  private async removeSeatWorktree(record: LocalSeat): Promise<void> {
    if (!record.worktree || record.worktree.removed) return;
    try { await removeWorktree(record.worktree.root, record.worktree.path); record.worktree.removed = true; await this.save(); } catch { /* Retried on the next tick. */ }
  }
  /** A bundle of a commit in the worker's repository, uploaded as the worker's seat for a remote supporter. */
  async supportBundle(input: { teamId: string; memberId: string; commit: string; base?: string; operationId: string }): Promise<unknown> {
    await this.ready;
    const record = this.records.find(item => item.seat.teamId === input.teamId && item.seat.member.id === input.memberId && item.seat.member.role === 'requester' && item.creation === 'ready');
    if (!record?.seat.member.cwd) throw new Error('The worker seat is not on this Host.');
    const bundle = await createBundle(record.seat.member.cwd, input.commit, input.base);
    try { return await this.resourceFiles.upload(input.teamId, input.memberId, bundle.file, input.operationId); }
    finally { await rm(bundle.directory, { recursive: true, force: true }); }
  }
  /** The patch of a supporter's worktree, uploaded as the supporter; empty when it changed nothing. */
  async supportPatch(input: { teamId: string; memberId: string; operationId: string }): Promise<unknown> {
    await this.ready;
    const record = this.records.find(item => item.seat.teamId === input.teamId && item.seat.member.id === input.memberId && item.creation === 'ready');
    const workspace = record?.seat.member.workspace;
    if (!record?.worktree || record.worktree.removed || (workspace?.kind !== 'worktree' && workspace?.kind !== 'remote')) throw new Error('The supporter\'s worktree is not on this Host.');
    const patch = await collectPatch(record.worktree.path, workspace.commit);
    if (!patch) return { empty: true };
    const directory = await mkdtemp(join(tmpdir(), 'agent-remote-patch-')), file = join(directory, `${record.seat.member.id}.patch`);
    try { await writeFile(file, patch); return await this.resourceFiles.upload(input.teamId, input.memberId, file, input.operationId); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  /** A support group's worker seat binds the existing worker session, or the session that holds its role now, and reports where it works. */
  private async bindWorker(seat: TeamSeat): Promise<TeamMember> {
    // A link seat is an assistant's main session, which need not be the session that started the link.
    if (!seat.link && (seat.member.providerId !== seat.source.providerId || seat.member.nativeSessionId !== seat.source.nativeSessionId)) throw new Error('The worker seat must name the worker session.');
    const current = this.access.sessionRouting.resolve(this.anchor(seat)).target;
    const worker = await this.access.acquire(current.providerId, current.nativeSessionId);
    try { seat.member.cwd = worker.agent.snapshot().payload.runtimeInfo.cwd; } finally { worker.release(); }
    if (!seat.member.cwd) throw new Error('The worker\'s working directory is unavailable.');
    seat.member.creation = 'ready'; seat.member.activity = 'unknown';
    this.records.push({ seat, creation: 'ready', receipts: Object.create(null) }); await this.save();
    return seat.member;
  }
  /** Binds a restored seat to its own session; undefined, with nothing recorded, when that session cannot be opened. */
  private async resume(seat: TeamSeat): Promise<TeamMember | undefined> {
    // A worktree supporter's worktree went with the archive.
    if (seat.member.workspace?.kind === 'worktree' || seat.member.workspace?.kind === 'remote') return undefined;
    seat.member.creation = 'ready'; seat.member.activity = 'unknown';
    // Recorded first, so the session opens with its role's extensions.
    const record: LocalSeat = { seat, creation: 'ready', receipts: Object.create(null) };
    this.records.push(record); await this.save();
    try {
      const target = this.access.sessionRouting.resolve(this.anchor(seat)).target;
      (await this.access.acquire(target.providerId, target.nativeSessionId)).release();
      return seat.member;
    } catch {
      this.records.splice(this.records.indexOf(record), 1); seat.member.creation = 'reserved'; await this.save();
      return undefined;
    }
  }
  private tools(seat: TeamSeat, actual: () => NativeSessionRef | undefined = () => this.anchor(seat)): AgentSessionExtensions {
    const { member, teamId } = seat;
    const assertCurrent = () => {
      if (this.closed || !this.access.available()) throw new Error('Team Host is unavailable.');
      const recipient = actual(); if (!recipient) throw new Error('Team recipient is not attached.');
      this.access.sessionRouting.assertCurrent(this.anchor(seat), recipient);
    };
    const request = async (input: TeamHostCall) => { assertCurrent(); const value = await this.request(input); assertCurrent(); return value; };
    const call = (input: Omit<TeamHostCall, 'teamId' | 'memberId'>) => request({ ...input, teamId, memberId: member.id } as TeamHostCall);
    const text = { type: 'string', minLength: 1, maxLength: 16000 }, id = { type: 'string', minLength: 1, maxLength: 256 };
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], execute: (args: Record<string, string>) => Promise<unknown>): AgentSessionTool => ({
      name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, execute: async args => JSON.stringify(await execute(args as Record<string, string>)),
    });
    const group = seat.callForSupport, coordinator = !!group && member.role === 'leader';
    const readSource = tool('read_source_session', 'Read a bounded page from the source conversation for context. The source agent has no Team tools and receives no automatic Team messages.', { before: { type: 'object', properties: { epoch: { type: 'string' }, seq: { type: 'integer' } }, required: ['epoch','seq'], additionalProperties: false } }, [], async args => {
      assertCurrent();
      const source = await this.access.acquire(seat.source.providerId, seat.source.nativeSessionId);
      try { assertCurrent(); const request = { requestId: randomUUID(), agentId: source.agent.agentId, direction: args.before ? 'before' as const : 'tail' as const, limit: 20, ...(args.before ? { cursor: args.before as unknown as {epoch:string;seq:number} } : {}) }; const page = (await source.agent.fetchTimeline(request)).payload; assertCurrent();
        let remaining = 48000; const entries = page.entries.filter(entry => { remaining -= JSON.stringify(entry).length; return remaining >= 0; });
        return { ...page, entries, truncated: entries.length !== page.entries.length }; }
      finally { source.release(); }
    });
    // A task's worker reads its brief as input and reports once; it has no Team inbox. Its tools come as a namespace where the
    // provider takes one, so reporting never waits for the person's approval.
    if (seat.task) {
      // A worktree task's report carries the path of its patch, saved on this Host where its owner works.
      const report = reportTaskTool(async input => call(member.workspace?.kind === 'worktree' ? { ...input, summary: await this.withPatch(seat, input.summary) } : input));
      const taskTools = bindAgentSessionTools([readSource, report, askOwnerTool(input => call(input))], assertCurrent), instructions = `${taskWorkerInstructions(seat)} ${locationInstructions(seat)}`;
      const access = member.access ? { access: member.access } : {};
      return this.access.toolNamespaces?.(member.providerId) ? { instructions, ...access, toolNamespaces: [{ name: TASK_WORKER_NAMESPACE, description: 'Agent Remote Control: this task\'s own tools, to read its owner\'s conversation, ask it, and report the result.', tools: taskTools }] }
        : { instructions, ...access, tools: taskTools };
    }
    const tools = [
      tool('read_team', 'Read members, responsibilities, progress, compact delivery status and a bounded page of complete messages addressed to you. This does not consume messages. Fully read incoming messages, then acknowledge their IDs with acknowledge_team_messages before acting. Use nextAfterMessageId as afterMessageId while hasMore is true. Accepted input is not completed work.', { afterMessageId: id }, [], async args => teamInbox(await call({ action: 'read' }), member.id, args.afterMessageId, { group: coordinator })),
      tool('acknowledge_team_messages', 'Acknowledge incoming message IDs you have completely read through read_team before acting on them. This records receipt, not task completion, and prevents later native reinjection. Never acknowledge unread or truncated bodies. Retry the same IDs after a lost response; accepted delivery receipts are idempotent. Claimed or uncertain native deliveries cannot be cleared by this tool.', { messageIds: { type: 'array', items: id, minItems: 1, maxItems: 32, uniqueItems: true } }, ['messageIds'], args => request({ action: 'acknowledge', teamId, memberId: member.id, messageIds: args.messageIds as unknown as string[], expectedNativeSessionId: actual()!.nativeSessionId })),
      tool('send_team_message', 'Send a task, question or evidence. Reuse operationId for the same request. Delivery is asynchronous; inspect read_team for its receipt. Members may send only to their Leader. Attach up to 8 uploaded or received resource IDs using resources; file bytes are not embedded in text.', { to: id, operationId: id, text, resources: {type:'array',items:id,minItems:1,maxItems:8,uniqueItems:true} }, ['to', 'operationId', 'text'], args => request({ action: 'send', teamId, memberId: member.id, to: args.to!, operationId: args.operationId!, text: args.text!, ...(args.resources ? {resources:args.resources as unknown as string[]} : {}) })),
      tool('upload_team_resource', 'Upload a regular file from an absolute path on this Host, up to 50 MiB. Reuse operationId to resume. Returns a verified resourceId for send_team_message resources; does not send or execute the file.', {path:{type:'string',minLength:1,maxLength:4096},operationId:id}, ['path','operationId'], args => this.resourceFiles.upload(teamId,member.id,args.path!,args.operationId!, assertCurrent)),
      tool('download_team_resource', 'Download a resource you uploaded or received to this Host and verify size and SHA256. Returns a localPath. Optional outputDirectory must be absolute. Existing different files are never overwritten; downloaded files are never executed.', {resourceId:id,outputDirectory:{type:'string',minLength:1,maxLength:4096}}, ['resourceId'], args => this.resourceFiles.download(teamId,member.id,args.resourceId!,args.outputDirectory, assertCurrent)),
      tool('report_team_progress', 'Record current progress, blocking questions or completion evidence. Also message the Leader when it needs to act.', { summary: { type: 'string', maxLength: 2048 } }, ['summary'], async args => teamMemberUpdate(await request({ action: 'report', teamId, memberId: member.id, summary: args.summary! }), member.id)),
    ];
    if (member.role === 'leader') {
      if (!group) tools.push(tool('describe_team_member', 'Record responsibilities agreed with the user. Include task scope, environment, permissions, dependencies and expected evidence. This does not dispatch work or grant native permissions.', { target: id, responsibility: { type: 'string', maxLength: 2048 } }, ['target', 'responsibility'], async args => teamMemberUpdate(await request({ action: 'describe_member', teamId, memberId: member.id, target: args.target!, responsibility: args.responsibility! }), args.target!)));
      tools.push(readSource);
    }
    if (coordinator) tools.push(...coordinatorTools(input => call(input as Omit<TeamHostCall, 'teamId' | 'memberId'>)));
    const inboxInstructions = ' After completely reading incoming messages from read_team, acknowledge those IDs with acknowledge_team_messages before acting on them. This confirms receipt, not task completion. Never acknowledge unread or truncated message bodies. Follow hasMore with nextAfterMessageId to read additional pages. Retry acknowledgement with the same IDs after a lost response; no user confirmation is needed.';
    const location = ` ${locationInstructions(seat)}`;
    if (group) return { instructions: (coordinator ? coordinatorInstructions(seat) : supporterInstructions(seat)) + location + inboxInstructions,
      tools: bindAgentSessionTools(tools, assertCurrent), ...(member.access ? { access: member.access } : {}) };
    return { instructions: (member.role === 'leader'
      ? `You are the executing Leader of Team ${teamId}, member ${member.id}. Discuss requirements with the user, analyze and implement directly, coordinate registered members, validate evidence and report delivery. Read the source session for necessary context, but do not ask its agent to do your work. Read read_team before delegating. Establish each member's responsibilities with the user and record them with describe_team_member. Remote paths and environments are independent. Shared working directories do not isolate file edits: coordinate changes with the user. Do not assume members remain available. Native permissions still apply. Await responses instead of repeatedly sending the same task.`
      : `You are worker ${member.id} in Team ${teamId}. Read read_team to find your Leader and current responsibility. Directly investigate, implement and verify assigned tasks in your local environment. Return evidence or clarification questions to the Leader with send_team_message. Do not implement until a task is assigned. Do not assume the paths of members on other Hosts exist here. Do not delegate to other members or change your authority. Native permissions still apply.`) + location + inboxInstructions,
      tools: bindAgentSessionTools(tools, assertCurrent), ...(member.access ? { access: member.access } : {}) };
  }
  async tick(): Promise<void> {
    if (this.closed || this.ticking || !this.access.available()) return;
    this.ticking = true;
    try {
      await this.ready;
      for (const record of this.records) if (record.creation === 'unknown') await this.removeSeatWorktree(record);
      if (!this.records.some(record => record.creation === 'ready')) return;
      const value = await this.request({ action: 'poll' });
      if (!Array.isArray(value) || !value.every(isTeam)) throw new Error('Invalid Team catalog.');
      await this.forgetEndedGroups(value as Team[]);
      await this.forgetFinishedTasks(value as Team[]);
      const retained = new Set<string>();
      // A main session's task updates wait for it to be idle and then arrive together, as one input.
      const updates = new Map<string, { lease: RemoteHostSessionLease; target: NativeSessionRef; items: Delivery[] }>();
      for (const record of this.records.filter(item => item.creation === 'ready')) {
        const team = (value as Team[]).find(team => team.id === record.seat.teamId);
        try { await this.reconcileReceipts(record, team); } catch { /* Retry receipt reads independently of other seats and lease cleanup. */ }
        const member = team?.members.find(item => item.id === record.seat.member.id);
        if (member?.creation === 'released' || team?.status === 'archiving') await this.removeSeatWorktree(record);
      }
      for (const team of value as Team[]) for (const member of team.members) {
        const record = this.records.find(item => item.seat.teamId === team.id && item.seat.member.id === member.id && item.creation === 'ready');
        if (!record || member.creation !== 'ready') continue;
        if (!member.nativeSessionId) continue;
        // A support group member's runtime is held while something must reach it, until it reports idle, and while an archive needs its presence;
        // otherwise the Host releases it when idle and the next delivery resumes the same session.
        // Ordinary Teams keep every member held: the user drives their sessions directly, and only a held runtime reports that presence.
        const pending = team.messages.some(item => item.to === member.id && (['queued','dispatching','unknown'].includes(item.status) || item.status === 'accepted' && !['started','handled'].includes(item.acceptance ?? '')));
        const leaseKey = `${team.id}:${member.id}`, current = this.leases.get(leaseKey);
        // The live session decides for a held runtime: reported presence can lag a delivery that just started a turn.
        // A running task's worker stays held, so its ended turns, pending interactions and the person's input to it are seen.
        const working = !!record.seat.task && member.role === 'leader' && (team.task?.state === 'working' || team.task?.state === 'needs_input');
        if ((record.seat.callForSupport || record.seat.task || record.seat.link) && !working && !pending && member.activity === 'idle' && team.status !== 'archiving' && !(current && !idle(current.lease))) continue;
        try {
          const target = this.access.sessionRouting.resolve(this.anchor(record.seat)).target;
          if (target.providerId !== member.providerId || target.nativeSessionId !== member.nativeSessionId) continue;
          this.access.sessionRouting.assertCurrent(this.anchor(record.seat), target);
          let held = this.leases.get(leaseKey);
          if (held && nativeSessionRefKey(held.target) !== nativeSessionRefKey(target)) { this.release(leaseKey, held); held = undefined; }
          if (!held) {
            const lease = await this.access.acquire(target.providerId, target.nativeSessionId); held = { target, lease };
            // While held, a support group's coordinator and supporters account their usage toward the group's budget.
            if (record.seat.callForSupport && member.role !== 'requester') { const seat = record; held.unsubscribe = lease.agent.subscribe(event => this.observeUsage(seat, event)); }
            if (record.seat.task && member.role === 'leader') { const seat = record; held.unsubscribe = lease.agent.subscribe(event => this.observeWorkerInput(seat, event)); }
            this.leases.set(leaseKey, held);
          }
          this.access.sessionRouting.assertCurrent(this.anchor(record.seat), target);
          retained.add(leaseKey); const lease = held.lease;
          // A task worker that was just given input may not show its turn yet: its presence waits for the next poll, so an ended turn is never inferred from it.
          let dispatched = false;
          for (const message of team.messages.filter(item => item.to === member.id && (['queued','dispatching','unknown'].includes(item.status) || item.status === 'accepted' && !['started','handled'].includes(item.acceptance ?? '')))) {
            const receipt = record.receipts[message.id];
            if (receipt && receipt.status !== 'dispatching') { await this.settle(team.id, member.id, message.id, receipt); continue; }
            if (message.status === 'dispatching' && !receipt) {
              // A claim survived but its local effect boundary did not. Never infer it was unexecuted.
              await this.settle(team.id, member.id, message.id, { status: 'unknown', resolvedTarget: message.resolvedTarget, error: 'Delivery claim has no local receipt. Inspect this session before resolving.' }); continue;
            }
            const quiet = !!record.seat.task || !!record.seat.link;
            if (message.status !== 'queued' || team.status !== 'active' || !availableDelivery(lease, !record.seat.callForSupport && !quiet, !quiet)) continue;
            if (quiet && member.role === 'requester') {
              const key = nativeSessionRefKey(target), batch = updates.get(key) ?? { lease, target, items: [] };
              batch.items.push({ record, team, message }); updates.set(key, batch);
            } else { await this.dispatch([{ record, team, message }], lease, target); dispatched = !!record.seat.task; }
          }
          this.access.sessionRouting.assertCurrent(this.anchor(record.seat), target);
          const interaction = working ? pendingInteraction(lease) : undefined;
          if (!dispatched) await this.request({ action: 'presence', teamId: team.id, memberId: member.id, activity: idle(lease) ? 'idle' : 'busy', ...(interaction ? { interaction } : {}) });
        } catch { /* Pending records remain durable; next poll retries reads and receipts, never uncertain effects. */ }
      }
      for (const batch of updates.values()) {
        try { await this.dispatch(batch.items.sort((a, b) => taskUpdatePriority(a.message) - taskUpdatePriority(b.message) || a.message.createdAt - b.message.createdAt), batch.lease, batch.target); }
        catch { /* Receipts stay durable; the next poll settles them and retries what was never sent. */ }
      }
      for (const [id, held] of this.leases) if (!retained.has(id)) this.release(id, held);
      for (const record of this.records) if (record.usage) await this.reportUsage(record).catch(() => undefined);
    } finally { this.ticking = false; }
  }
  /**
   * Forgets the seats of support groups that were archived or removed: a reopened group provisions its seats again, and the Relay
   * removes groups to make room or when the user deletes them. The poll omits archived groups, so the Relay is asked about missing
   * ones, each at most every ten minutes.
   */
  private async forgetEndedGroups(listed: readonly Team[]): Promise<void> {
    if (this.access.callForSupport?.() !== true) return;
    const now = Date.now(), present = new Set(listed.map(team => team.id));
    for (const id of [...this.groupChecks.keys()]) if (present.has(id)) this.groupChecks.delete(id);
    const due = [...new Set(this.records.filter(record => record.seat.callForSupport && record.creation !== 'dispatching' && !present.has(record.seat.teamId)).map(record => record.seat.teamId))]
      .filter(id => (this.groupChecks.get(id) ?? 0) <= now).slice(0, 64);
    if (!due.length) return;
    for (const id of due) this.groupChecks.set(id, now + 600_000);
    const asked = this.bindings;
    let states: unknown;
    try { states = (await this.request({ action: 'support_group_states', teamIds: due }) as { states?: unknown }).states; } catch { return; }
    if (!Array.isArray(states)) return;
    // A group whose seats were bound while asking was restored meanwhile.
    const ended = new Set(states.filter(state => state && typeof state === 'object' && due.includes(state.teamId) && (state.status === 'archived' || state.status === 'missing'))
      .map(state => state.teamId as string).filter(id => (this.boundAt.get(id) ?? 0) <= asked));
    if (!ended.size) return;
    const forgotten = new Set<LocalSeat>();
    for (const record of this.records.filter(item => ended.has(item.seat.teamId))) {
      const key = `${record.seat.teamId}:${record.seat.member.id}`, held = this.leases.get(key);
      if (held) this.release(key, held);
      // A seat whose worktree could not be removed stays until it can: it is the only record of where the worktree is.
      await this.removeSeatWorktree(record);
      if (!record.worktree || record.worktree.removed) forgotten.add(record);
    }
    this.records = this.records.filter(item => !forgotten.has(item));
    for (const id of ended) if (!this.records.some(item => item.seat.teamId === id)) { this.groupChecks.delete(id); this.boundAt.delete(id); }
    await this.save();
  }
  /**
   * Forgets the seats of tasks that finished and whose deliveries settled, and of tasks the Relay removed: a task's seats are never
   * used again, and every task would otherwise hold two of the Host's seats.
   */
  private async forgetFinishedTasks(listed: readonly Team[]): Promise<void> {
    if (this.access.tasks?.() !== true) return;
    const settled = (team: Team, memberId: string) => !team.messages.some(message => message.to === memberId && (['queued', 'dispatching', 'unknown'].includes(message.status)
      || message.status === 'accepted' && !['started', 'handled'].includes(message.acceptance ?? '')));
    const forgotten = new Set<LocalSeat>(), cancelled = new Set<LocalSeat>(), now = Date.now();
    for (const record of this.records) {
      if (!record.seat.task || record.creation === 'dispatching' || Object.values(record.receipts).some(receipt => receipt.status === 'dispatching' || receipt.status === 'unknown')) continue;
      const team = listed.find(item => item.id === record.seat.teamId);
      if (team) {
        this.missingTasks.delete(team.id);
        if (team.task?.state === 'cancelled' && record.seat.member.role === 'leader') cancelled.add(record);
        if (team.task?.state !== 'working' && team.task?.state !== 'needs_input' && settled(team, record.seat.member.id)) forgotten.add(record);
        continue;
      }
      // A Team just created can be missing from a poll answered before its seats were committed; only a long absence means the Relay removed it.
      const since = this.missingTasks.get(record.seat.teamId) ?? now;
      this.missingTasks.set(record.seat.teamId, since);
      if (record.creation !== 'ready' || now - since >= TASK_MISSING_FORGET_MS) forgotten.add(record);
    }
    if (!forgotten.size) return;
    for (const record of forgotten) {
      const key = `${record.seat.teamId}:${record.seat.member.id}`, held = this.leases.get(key);
      if (held) {
        // A stopped task's worker stops its running turn before its runtime is let go.
        if (cancelled.has(record) && !idle(held.lease)) await this.access.execute(held.lease.agent, { operationId: operationId(`task-cancel:${record.seat.teamId}`), kind: 'cancel', parameters: null, maximumResultBytes: 4096 },
          { dispatch: async () => { await held.lease.agent.cancel?.(); } }).catch(() => undefined);
        this.release(key, held);
      }
      // A worktree task's changes went to its owner as a patch with the report.
      await this.removeSeatWorktree(record);
    }
    this.records = this.records.filter(item => !forgotten.has(item));
    for (const id of [...this.missingTasks.keys()]) if (!this.records.some(item => item.seat.teamId === id)) this.missingTasks.delete(id);
    await this.save();
  }
  private async reconcileReceipts(record: LocalSeat, team?: Team): Promise<void> {
    const pending = Object.entries(record.receipts).filter(([id, receipt]) => !team?.messages.some(message => message.id === id)
      && (['dispatching', 'unknown'].includes(receipt.status) || receipt.status === 'accepted' && !['started', 'handled'].includes(receipt.acceptance ?? '')));
    if (!pending.length) return;
    const value = await this.request({ action: 'read', teamId: record.seat.teamId, memberId: record.seat.member.id }) as Team & { receipts?: unknown[] };
    if (!value || typeof value !== 'object') return;
    const { receipts, ...publicTeam } = value;
    if (!Array.isArray(receipts) || !isTeam(publicTeam) || publicTeam.id !== record.seat.teamId) return;
    let changed = false;
    for (const [id, local] of pending) {
      const receipt = receipts.find(row => row && typeof row === 'object' && 'id' in row && row.id === id) as TeamMessage | undefined;
      if (!receipt || receipt.to !== record.seat.member.id || !isTeam({ ...publicTeam, messages: [{ ...receipt, text: 'receipt' }] })
        || !(receipt.status === 'rejected' || receipt.status === 'accepted' && ['started', 'handled'].includes(receipt.acceptance ?? ''))
        || receipt.resolvedTarget && local.resolvedTarget && nativeSessionRefKey(receipt.resolvedTarget) !== nativeSessionRefKey(local.resolvedTarget)) continue;
      local.status = receipt.status; local.acceptance = receipt.acceptance; local.error = receipt.error; changed = true;
    }
    if (changed) await this.save();
  }
  private settle(teamId: string, memberId: string, messageId: string, receipt: {status:string;error?:string;acceptance?:AgentInputAcceptance['disposition'];resolvedTarget?:NativeSessionRef}) {
    return this.request({ action: 'settle', teamId, memberId, messageId, outcome: receipt.status as 'accepted'|'rejected'|'unknown', ...(receipt.resolvedTarget ? {resolvedTarget:receipt.resolvedTarget} : {}), ...(receipt.acceptance ? {acceptance:receipt.acceptance} : {}), ...(receipt.error ? {error:receipt.error} : {}) });
  }
  /**
   * Delivers one input to a session: one message, or several task updates of one main session joined. Each message is claimed and its
   * receipt made durable before the one native call; they settle together.
   */
  private async dispatch(items: Delivery[], lease: RemoteHostSessionLease, target: NativeSessionRef) {
    const first = items[0]!, seat = first.record.seat;
    // Support groups and tasks deliver between turns: steering races a turn that is ending, and their work does not need it.
    // The Relay frames what a requester and a task's worker read.
    const quiet = !!seat.task || !!seat.link;
    const framed = seat.member.role === 'requester' || !!seat.task, delivery = availableDelivery(lease, !seat.callForSupport && !quiet, !quiet);
    if (!delivery || this.closed || !this.access.available()) return;
    this.access.sessionRouting.assertCurrent(this.anchor(seat), target);
    const receipts: Array<{ item: Delivery; receipt: LocalSeat['receipts'][string] }> = [];
    const check = () => {
      for (const { record } of items) {
        try { this.access.sessionRouting.assertCurrent(this.anchor(record.seat), target); }
        catch (error) { throw new AgentOperationRejectedError('team_recipient_unavailable', errorText(error)); }
      }
      if (this.closed || !this.access.available() || !deliveryAllowed(lease, delivery)) throw new AgentOperationRejectedError('team_not_ready', 'Team session is not ready for this input delivery.');
    };
    const textOf = ({ team, message }: Delivery) => {
      if (framed) return message.text;
      const sender = team.members.find(member => member.id === message.from);
      const attachments = message.resources?.map((resource,index) => `[resource #${index+1}] ${JSON.stringify(resource)} (Use download_team_resource with resourceId to obtain a verified local file.)`).join('\n');
      // A worker reads support reports as the Relay framed them; Team internals stay with the coordinator.
      return `[Team ${team.id}; message ${message.id}; from ${sender?.name ?? message.from}]\n${message.text}${attachments ? `\n\nAttached resources:\n${attachments}` : ''}`;
    };
    const settleAll = () => Promise.all(receipts.map(({ item, receipt }) => this.settle(item.team.id, item.record.seat.member.id, item.message.id, receipt)));
    try {
      // Succession must not prepare between the claims and their durable receipts, which then take over as the fence.
      const recipient = nativeSessionRefKey(target);
      this.claiming.set(recipient, (this.claiming.get(recipient) ?? 0) + 1);
      try {
        for (const item of items) {
          // A message that cannot be claimed now stays queued for a later poll; the ones claimed are still delivered.
          let claim: TeamMessage;
          try { claim = await this.request({ action: 'claim', teamId: item.team.id, memberId: item.record.seat.member.id, messageId: item.message.id, expectedNativeSessionId: target.nativeSessionId }) as TeamMessage; }
          catch (error) { if (items.length === 1) throw error; continue; }
          if (!claim.resolvedTarget || nativeSessionRefKey(claim.resolvedTarget) !== nativeSessionRefKey(target)) throw new Error('Claim recipient could not be verified.');
          const receipt = { text: item.message.text, status: 'dispatching' as const, resolvedTarget: structuredClone(claim.resolvedTarget) };
          item.record.receipts[item.message.id] = receipt; receipts.push({ item, receipt });
          await this.save();
        }
      } finally {
        const remaining = (this.claiming.get(recipient) ?? 1) - 1;
        if (remaining > 0) this.claiming.set(recipient, remaining); else this.claiming.delete(recipient);
      }
      if (!receipts.length) return;
      const text = receipts.length === 1 ? textOf(receipts[0]!.item) : joinTaskInputs(receipts.map(({ item }) => textOf(item)));
      const onAcceptance = (acceptance: AgentInputAcceptance) => {
        if (!receipts.length || !['started','queued','handled'].includes(acceptance.disposition) || this.closed) return;
        for (const { receipt } of receipts) {
          if (receipt.acceptance !== 'started' && receipt.acceptance !== 'handled') receipt.acceptance = acceptance.disposition;
          receipt.status = 'accepted'; delete receipt.error;
        }
        void this.save().then(settleAll).catch(() => {});
      };
      // Stopping the recipient removed this input before it ran; report it undelivered so the sender can resend.
      const onWithdrawn = () => {
        if (this.closed) return;
        let changed = false;
        for (const { receipt } of receipts) {
          if (receipt.acceptance === 'started' || receipt.acceptance === 'handled') continue;
          receipt.status = 'rejected'; delete receipt.acceptance; receipt.error = 'The recipient was stopped before this message ran. Send it again if it is still needed.'; changed = true;
        }
        if (changed) void this.save().then(settleAll).catch(() => {});
      };
      const identity = receipts.length === 1 ? receipts[0]!.item.message.id : receipts.map(({ item }) => item.message.id).sort().join(':');
      const result = await this.access.execute(lease.agent, { operationId: operationId(identity), kind: 'send_message', parameters: { text, delivery }, maximumResultBytes: 4096 }, {
        beforeDispatch: check,
        dispatch: async () => {
          check(); return lease.agent.sendMessage(text, {delivery,onAcceptance,onWithdrawn});
        },
      });
      if (result && typeof result === 'object' && 'disposition' in result && ['started','queued','handled'].includes(String(result.disposition))) onAcceptance(result as AgentInputAcceptance);
      // A fulfilled SDK operation confirms acceptance without inventing a native disposition.
      for (const { receipt } of receipts) if (receipt.status === 'dispatching') receipt.status = 'accepted';
    } catch (error) {
      if (!receipts.length) return;
      for (const { receipt } of receipts) {
        if (receipt.status !== 'accepted') receipt.status = error instanceof AgentOperationRejectedError || error instanceof OperationCacheError && !['operation_outcome_unknown', 'native_file_limit'].includes(error.code) ? 'rejected' : 'unknown';
        receipt.error = errorText(error);
      }
    }
    if (receipts.length) { await this.save(); await settleAll(); }
  }
  private release(key: string, held: { lease: RemoteHostSessionLease; unsubscribe?: () => void }) { held.unsubscribe?.(); held.lease.release(); this.leases.delete(key); }
  /** What the person writes to a task's worker directly reaches its owner too; the Relay's own framed inputs do not. */
  private observeWorkerInput(record: LocalSeat, event: AgentManagerEvent): void {
    if (event.type !== 'agent_stream' || event.delivery === 'history' || event.event.type !== 'timeline' || event.event.item.type !== 'user_message') return;
    const item = event.event.item, text = item.text.trim();
    if (!text || item.withdrawn || parseTaskInputs(text)) return;
    const id = item.messageId ?? item.clientMessageId ?? createHash('sha256').update(text).digest('hex').slice(0, 64);
    void this.request({ action: 'tell_task', teamId: record.seat.teamId, memberId: record.seat.member.id, operationId: id,
      text: text.length > TASK_TOLD_LIMIT ? `${text.slice(0, TASK_TOLD_LIMIT - 1)}…` : text }).catch(() => undefined);
  }
  private observeUsage(record: LocalSeat, event: AgentManagerEvent): void {
    if (event.type !== 'agent_stream' || event.delivery === 'history') return;
    const update = event.event.type === 'usage_updated' ? event.event.usage : event.event.type === 'turn_completed' ? event.event.usage : undefined;
    if (!update || !accountUsage(record.usage ??= { tokens: 0 }, update, event.event.type === 'turn_completed')) return;
    if (event.event.type === 'turn_completed' || Date.now() - (record.usage.reported?.at ?? 0) >= 10_000) void this.reportUsage(record).catch(() => undefined);
  }
  /** Sends a member's cumulative usage when it grew; the Relay counts the increase toward the call and the group. */
  private async reportUsage(record: LocalSeat): Promise<void> {
    const usage = record.usage;
    if (!usage || usage.tokens === (usage.reported?.tokens ?? 0) && usage.costUsd === usage.reported?.costUsd) return;
    const tokens = usage.tokens, costUsd = usage.costUsd;
    await this.save();
    await this.request({ action: 'report_usage', teamId: record.seat.teamId, memberId: record.seat.member.id, tokens, ...(costUsd !== undefined ? { costUsd } : {}) });
    usage.reported = { tokens, ...(costUsd !== undefined ? { costUsd } : {}), at: Date.now() };
    await this.save();
  }
  async close() { this.closed = true; clearInterval(this.timer); for (const held of this.leases.values()) { held.unsubscribe?.(); held.lease.release(); } this.leases.clear(); await this.persistence; }
}
