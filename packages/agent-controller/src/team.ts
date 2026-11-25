import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentOperationRejectedError, bindAgentSessionTools, type AgentInputAcceptance, type AgentSessionExtensions, type AgentSessionTool, type AgentSessionToolNamespace } from '@orchardworks/agent-provider-sdk';
import type { SessionExecutionRouting } from './session-succession-service.js';
import type { RoleSuccessionDecision, SessionRole } from './session-role-succession.js';
import type { SessionCreation } from './role-session-creation.js';
import { TASK_WORKER_NAMESPACE, taskWorkerInstructions } from './task-roles.js';
import { botInstructions } from './bot-instructions.js';
import { collectPatch, prepareWorktree, removeWorktree, repositoryRoot, worktreePath } from './worktrees.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isNativeSessionRef, joinTaskInputs, nativeSessionRefKey, parseTaskInputs, TASK_SUMMARY_LIMIT, TASK_TOLD_LIMIT, type NativeSessionRef, isTeam, isTeamSeat, sessionOperationAvailability, type Team, type TeamHostCall, type TeamMember, type TeamMessage, type TeamSeat } from '@orchardworks/agent-remote-protocol';
import { OperationCacheError, type AgentManagerEvent, type RemoteHostSessionLease, type SessionWireOperationExecutor } from '@orchardworks/agent-session-runtime';

export interface TeamRuntimeAccess {
  /** Every bot's tools, bound to the session that calls them: what a temporary bot (a task's worker) uses to report and message. */
  botTools?(actual: () => NativeSessionRef | undefined): AgentSessionToolNamespace;
  controllerId: string;
  /** Role routing: a seat follows every committed succession of its session, including one to another provider. */
  sessionRouting: SessionExecutionRouting;
  /** The Relay routes Team recipients across a generic succession of their session. */
  genericSuccession?(): boolean;
  /** The Relay sends this Controller bots: tasks, inboxes, links and rooms. */
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
  /** A worktree bot's own worktree, removed once its creation failed or its task ended. */
  worktree?: { root: string; path: string; removed?: true };
  /** The last stop the person asked of this seat's session that its turn was stopped for (bots design 7). */
  interrupted?: number;
  receipts: Record<string, { text: string; status: 'dispatching' | 'accepted' | 'rejected' | 'unknown'; error?: string; acceptance?: AgentInputAcceptance['disposition']; resolvedTarget?: NativeSessionRef }> }
/** Where a bot's session runs. */
function locationInstructions(seat: TeamSeat): string {
  return `You are on Host ${seat.member.hostId}${seat.member.cwd ? `, working in ${seat.member.cwd}` : ''}.`;
}
/** A seat of a bot: a task's worker or owner, a link, a room, an inbox or an answer session. An ordinary Team's seat is none of these. */
const bound = (seat: TeamSeat) => !!(seat.task || seat.link || seat.room || seat.inbox || seat.ask || seat.member.role === 'requester');
/** One message to deliver, with the seat it reaches and its Team. */
interface Delivery { record: LocalSeat; team: Team; message: TeamMessage }
/** A main session reads what waits on it before the rest. */
/** At idle a main session reads what waits on it first, then other task updates, then other assistants' messages. */
const taskUpdatePriority = (message: TeamMessage) => /^\[Task \S+ · (question|needs the person) · /.test(message.text) || message.text.startsWith('[The person wrote to ') ? 0 : message.text.startsWith('[Message from ') || message.text.startsWith('[Room ') ? 2 : 1;
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
 * steer: input may join a running turn. Input of tasks, inboxes, links and rooms never does; it waits for the session's next turn.
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
  private ticking = false;
  private closed = false;
  /** Recipients with a claim request in flight, before its receipt is durable. */
  private readonly claiming = new Map<string, number>();
  /** When each task Team was first missing from the poll. */
  private readonly missingTasks = new Map<string, number>();
  /** Counts seat bindings, so a group restored while its archive was being confirmed keeps its new seats. */
  private bindings = 0;
  private readonly boundAt = new Map<string, number>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly directory: string, private readonly access: TeamRuntimeAccess, private readonly request: (call: TeamHostCall) => Promise<unknown>, tickMs = 3000) {
    this.ready = this.restore();
    void this.ready.catch(() => undefined);
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, tickMs); this.timer.unref?.();
  }
  private async restore() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.records = JSON.parse(await readFile(join(this.directory, 'seats.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Seats of Call For Support groups, which bots replaced (bots design 9): forgotten, with the worktrees they left.
    const legacy = Array.isArray(this.records) ? this.records.filter(record => record?.seat && Object.hasOwn(record.seat, 'callForSupport')) : [];
    if (legacy.length) {
      this.records = this.records.filter(record => !legacy.includes(record));
      for (const record of legacy) if (record.worktree && !record.worktree.removed) await removeWorktree(record.worktree.root, record.worktree.path).catch(() => undefined);
      await this.save();
    }
    // Seats of ordinary Teams, which bots replaced (bots design 9): forgotten with the worktrees they left. Seats of tasks, links, rooms and inboxes stay.
    const ordinary = Array.isArray(this.records) ? this.records.filter(record => record?.seat && !bound(record.seat)) : [];
    if (ordinary.length) {
      this.records = this.records.filter(record => !ordinary.includes(record));
      for (const record of ordinary) if (record.worktree && !record.worktree.removed) await removeWorktree(record.worktree.root, record.worktree.path).catch(() => undefined);
      await this.save();
    }
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
  /** Whether this session is a ready answer session of this Host. */
  answering(ref: NativeSessionRef): boolean {
    return this.records.some(record => record.seat.ask && record.creation === 'ready' && record.seat.member.providerId === ref.providerId && record.seat.member.nativeSessionId === ref.nativeSessionId);
  }
  /** Whether this session is a ready worker of a temporary bot of this Host. */
  working(ref: NativeSessionRef): boolean {
    return this.records.some(record => record.seat.task && record.seat.member.role === 'leader' && record.creation === 'ready' && record.seat.member.providerId === ref.providerId && record.seat.member.nativeSessionId === ref.nativeSessionId);
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
      // A requester seat is an existing main session, which keeps its own role.
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
    if (isTeamSeat(seat) && !bound(seat)) throw new Error('Teams of a person\'s own making no longer exist; start a bot instead.');
    if (!isTeamSeat(seat) || !this.access.available() || seat.member.role !== 'requester' && !this.access.supportedProviders().includes(seat.member.providerId)) throw new Error('Provider does not support Team tools on this Host.');
    if ((seat.task || seat.link || seat.room || seat.inbox || seat.ask || seat.member.role === 'requester') && this.access.tasks?.() !== true) throw new Error('Update the Relay to use tasks.');
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
    // An answer session is read-only where its provider enforces that, and otherwise works as the provider allows.
    if (seat.ask && seat.member.access === 'read_only' && !(this.access.readOnlyProviders?.() ?? []).includes(seat.member.providerId)) delete seat.member.access;
    if (seat.member.role === 'requester') return this.bindWorker(seat);
    // A member created in a folder the Relay chose (a bot on another Host) works there; any other starts where its source works.
    if (seat.member.role === 'leader' && !seat.member.cwd) {
      const source = await this.access.acquire(seat.source.providerId, seat.source.nativeSessionId);
      try { seat.member.cwd = source.agent.snapshot().payload.runtimeInfo.cwd; } finally { source.release(); }
      if (!seat.member.cwd) throw new Error('Source working directory is unavailable.');
    }
    let worktree: LocalSeat['worktree'];
    const workspace = seat.member.workspace;
    if (workspace?.kind === 'worktree') {
      if (!seat.member.cwd) throw new Error('The worktree\'s repository is unknown.');
      const repository = seat.member.cwd;
      try {
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
  /** A worktree bot's patch against its commit, saved on this Host, as the line its chief reads; undefined without changes. */
  private async patchLine(seat: TeamSeat): Promise<string | undefined> {
    const record = this.records.find(item => item.seat.teamId === seat.teamId && item.seat.member.id === seat.member.id), workspace = seat.member.workspace;
    if (!record?.worktree || record.worktree.removed || workspace?.kind !== 'worktree') throw new Error('This task\'s worktree is not on this Host.');
    const patch = await collectPatch(record.worktree.path, workspace.commit);
    if (!patch) return undefined;
    const directory = join(this.directory, 'task-patches'), file = join(directory, `${seat.teamId}.patch`);
    await mkdir(directory, { recursive: true }); await writeFile(file, patch);
    return `Patch of the worktree's changes against ${workspace.commit.slice(0, 12)} (apply with git apply): ${file}`;
  }
  /** The patch line of the worktree bot whose session this is; undefined for any other session. */
  async patchFor(ref: NativeSessionRef): Promise<string | undefined> {
    const record = this.records.find(item => item.seat.task && item.seat.member.role === 'leader' && item.seat.member.workspace?.kind === 'worktree'
      && item.seat.member.providerId === ref.providerId && item.seat.member.nativeSessionId === ref.nativeSessionId);
    return record ? this.patchLine(record.seat) : undefined;
  }
  /** Removes a seat's worktree once; a failure is retried on a later tick. */
  private async removeSeatWorktree(record: LocalSeat): Promise<void> {
    if (!record.worktree || record.worktree.removed) return;
    try { await removeWorktree(record.worktree.root, record.worktree.path); record.worktree.removed = true; await this.save(); } catch { /* Retried on the next tick. */ }
  }
  /** A requester seat binds an existing main session, or the session that holds its role now, and reports where it works. */
  private async bindWorker(seat: TeamSeat): Promise<TeamMember> {
    // A link seat is an assistant's main session, which need not be the session that started the link.
    if (!seat.link && !seat.room && !seat.inbox && (seat.member.providerId !== seat.source.providerId || seat.member.nativeSessionId !== seat.source.nativeSessionId)) throw new Error('The worker seat must name the worker session.');
    const current = this.access.sessionRouting.resolve(this.anchor(seat)).target;
    const worker = await this.access.acquire(current.providerId, current.nativeSessionId);
    try { seat.member.cwd = worker.agent.snapshot().payload.runtimeInfo.cwd; } finally { worker.release(); }
    if (!seat.member.cwd) throw new Error('The worker\'s working directory is unavailable.');
    seat.member.creation = 'ready'; seat.member.activity = 'unknown';
    this.records.push({ seat, creation: 'ready', receipts: Object.create(null) }); await this.save();
    return seat.member;
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
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], execute: (args: Record<string, string>) => Promise<unknown>): AgentSessionTool => ({
      name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, execute: async args => JSON.stringify(await execute(args as Record<string, string>)),
    });
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
    // A standing bot another bot created: its session starts with its standing instructions and every bot's tools.
    if (seat.inbox) {
      const bots = this.access.botTools?.(actual);
      const instructions = `${botInstructions(seat.inbox.mission)} ${locationInstructions(seat)}`;
      return this.access.toolNamespaces?.(member.providerId) ? { instructions, ...(bots ? { toolNamespaces: [bots] } : {}) } : { instructions, ...(bots ? { tools: bots.tools } : {}) };
    }
    // A bot's answer session: its bot's mission and memory, and its tools, which the Relay narrows to reading, the board and the memory.
    if (seat.ask) {
      const bots = this.access.botTools?.(actual);
      const instructions = `${botInstructions(seat.ask.mission, seat.ask.memory)}\n\nThis session is an answer session of this bot, not its main session: the person asks you questions from their other conversations, and you answer in your final text. Your main session keeps coordinating. ${locationInstructions(seat)}`;
      const access = member.access ? { access: member.access } : {};
      return this.access.toolNamespaces?.(member.providerId) ? { instructions, ...access, ...(bots ? { toolNamespaces: [bots] } : {}) } : { instructions, ...access, ...(bots ? { tools: bots.tools } : {}) };
    }
    if (seat.task) {
      // A temporary bot has every bot's tools, called as its own session; it reports to its chief with message.
      const bots = this.access.botTools?.(actual);
      const standing = botInstructions(undefined);
      const instructions = `${standing}\n\n${taskWorkerInstructions(seat)} ${locationInstructions(seat)}`;
      const access = member.access ? { access: member.access } : {};
      const own = bindAgentSessionTools([readSource], assertCurrent);
      return this.access.toolNamespaces?.(member.providerId)
        ? { instructions, ...access, toolNamespaces: [...(bots ? [bots] : []), { name: TASK_WORKER_NAMESPACE, description: 'Agent Remote Control: read your chief\'s conversation.', tools: own }] }
        : { instructions, ...access, tools: [...own, ...(bots?.tools ?? [])] };
    }
    throw new Error('Only bots carry Team tools.');
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
      await this.forgetFinishedTasks(value as Team[]);
      const retained = new Set<string>();
      // A main session's task updates wait for it to be idle and then arrive together, as one input.
      const updates = new Map<string, { lease: RemoteHostSessionLease; target: NativeSessionRef; items: Delivery[] }>();
      for (const record of this.records.filter(item => item.creation === 'ready')) {
        const team = (value as Team[]).find(team => team.id === record.seat.teamId);
        try { await this.reconcileReceipts(record, team); } catch { /* Retry receipt reads independently of other seats and lease cleanup. */ }
      }
      for (const team of value as Team[]) for (const member of team.members) {
        const record = this.records.find(item => item.seat.teamId === team.id && item.seat.member.id === member.id && item.creation === 'ready');
        if (!record || member.creation !== 'ready') continue;
        if (!member.nativeSessionId) continue;
        if (member.interrupt !== undefined && member.interrupt !== record.interrupted) await this.interrupt(record, member.interrupt).catch(() => undefined);
        // A runtime of a task, link, room or inbox is held while something must reach it and until it reports idle; otherwise the Host
        // releases it when idle and the next delivery resumes the same session.
        const pending = team.messages.some(item => item.to === member.id && (['queued','dispatching','unknown'].includes(item.status) || item.status === 'accepted' && !['started','handled'].includes(item.acceptance ?? '')));
        const leaseKey = `${team.id}:${member.id}`, current = this.leases.get(leaseKey);
        // The live session decides for a held runtime: reported presence can lag a delivery that just started a turn.
        // A running task's worker stays held, so its ended turns, pending interactions and the person's input to it are seen.
        const working = !!record.seat.task && member.role === 'leader' && (team.task?.state === 'working' || team.task?.state === 'needs_input');
        if (!working && !pending && member.activity === 'idle' && !(current && !idle(current.lease))) continue;
        try {
          const target = this.access.sessionRouting.resolve(this.anchor(record.seat)).target;
          if (target.providerId !== member.providerId || target.nativeSessionId !== member.nativeSessionId) continue;
          this.access.sessionRouting.assertCurrent(this.anchor(record.seat), target);
          let held = this.leases.get(leaseKey);
          if (held && nativeSessionRefKey(held.target) !== nativeSessionRefKey(target)) { this.release(leaseKey, held); held = undefined; }
          if (!held) {
            const lease = await this.access.acquire(target.providerId, target.nativeSessionId); held = { target, lease };
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
            if (message.status !== 'queued' || team.status !== 'active' || !availableDelivery(lease, false, false)) continue;
            // A queued acknowledgement reaches a seat with the input it waited for, so a worker takes them together as a main session does.
            if (member.role === 'requester' || team.messages.some(item => item.to === member.id && item.ack && item.status === 'queued')) {
              const key = nativeSessionRefKey(target), batch = updates.get(key) ?? { lease, target, items: [] };
              batch.items.push({ record, team, message }); updates.set(key, batch); dispatched = member.role !== 'requester' && !!record.seat.task;
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
    } finally { this.ticking = false; }
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
      if (!(record.seat.task || record.seat.ask) || record.creation === 'dispatching' || Object.values(record.receipts).some(receipt => receipt.status === 'dispatching' || receipt.status === 'unknown')) continue;
      const team = listed.find(item => item.id === record.seat.teamId);
      if (team) {
        this.missingTasks.delete(team.id);
        if (team.task?.state === 'cancelled' && record.seat.member.role === 'leader') cancelled.add(record);
        // An answer session stays while the Relay lists it; a retired one is no longer listed.
        if (record.seat.task && team.task?.state !== 'working' && team.task?.state !== 'needs_input' && settled(team, record.seat.member.id)) forgotten.add(record);
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
    // Tasks, links, rooms and inboxes deliver between turns: steering races a turn that is ending, and their work does not need it.
    // The Relay frames what a bot reads.
    const delivery = availableDelivery(lease, false, false);
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
    const textOf = ({ message }: Delivery) => message.text;
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
  /** The person stopped what this seat's session works on: a running turn stops, once for each stop the Relay records. */
  private async interrupt(record: LocalSeat, at: number): Promise<void> {
    const target = this.access.sessionRouting.resolve(this.anchor(record.seat)).target;
    const held = [...this.leases.values()].find(item => nativeSessionRefKey(item.target) === nativeSessionRefKey(target));
    const lease = held?.lease ?? await this.access.acquire(target.providerId, target.nativeSessionId);
    try {
      if (!idle(lease)) await this.access.execute(lease.agent, { operationId: operationId(`chain-stop:${record.seat.teamId}:${record.seat.member.id}:${at}`), kind: 'cancel', parameters: null, maximumResultBytes: 4096 },
        { dispatch: async () => { await lease.agent.cancel?.(); } });
    } finally { if (!held) lease.release(); }
    record.interrupted = at; await this.save();
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
  async close() { this.closed = true; clearInterval(this.timer); for (const held of this.leases.values()) { held.unsubscribe?.(); held.lease.release(); } this.leases.clear(); await this.persistence; }
}
