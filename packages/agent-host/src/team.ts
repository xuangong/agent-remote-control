import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentOperationRejectedError, bindAgentSessionTools, type AgentInputAcceptance, type AgentSessionExtensions, type AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import { isTeam, isTeamSeat, sessionOperationAvailability, type Team, type TeamHostCall, type TeamMember, type TeamMessage, type TeamSeat } from '@orchardworks/agent-remote-protocol';
import { OperationCacheError, type RemoteHostSessionLease, type SessionWireOperationExecutor } from '@orchardworks/agent-remote-relay';

export interface TeamRuntimeAccess {
  available(): boolean;
  supportedProviders(): string[];
  create(provider: string, cwd: string | undefined, extensions: AgentSessionExtensions): Promise<string>;
  acquire(provider: string, sessionId: string): Promise<RemoteHostSessionLease>;
  execute: SessionWireOperationExecutor;
}
interface LocalSeat { seat: TeamSeat; creation: 'dispatching' | 'ready' | 'unknown'; receipts: Record<string, { text: string; status: 'dispatching' | 'accepted' | 'rejected' | 'unknown'; error?: string; acceptance?: AgentInputAcceptance['disposition'] }> }
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Team operation failed.').slice(0, 2048);
function operationId(value: string) {
  const hex = createHash('sha256').update(value).digest('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function idle(lease: RemoteHostSessionLease): boolean {
  const state = lease.agent.snapshot().payload;
  return state.status === 'idle' && state.activeTurn === null && !state.pendingInteractions.length && sessionOperationAvailability(state, 'send_message').allowed;
}

/** Local native bindings and delivery evidence outlive browser and transport connections. */
export class TeamRuntime {
  readonly ready: Promise<void>;
  private records: LocalSeat[] = [];
  private persistence: Promise<unknown> = Promise.resolve();
  private creations = new Map<string, Promise<TeamMember>>();
  private leases = new Map<string, RemoteHostSessionLease>();
  private ticking = false;
  private closed = false;
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
    if (!Array.isArray(this.records) || this.records.length > 384 || this.records.some(record => !record || !isTeamSeat(record.seat) || !record.receipts || typeof record.receipts !== 'object' || Array.isArray(record.receipts) || Object.values(record.receipts).some(receipt => !receipt || typeof receipt.text !== 'string' || !['dispatching','accepted','rejected','unknown'].includes(receipt.status) || receipt.acceptance !== undefined && !['started','queued','handled'].includes(receipt.acceptance)) || !['dispatching','ready','unknown'].includes(record.creation))) throw new Error('Invalid saved Team bindings.');
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
  async extensions(provider: string, nativeSessionId: string): Promise<AgentSessionExtensions | undefined> {
    await this.ready;
    const record = this.records.find(item => item.seat.member.providerId === provider && item.seat.member.nativeSessionId === nativeSessionId);
    return record ? this.tools(record.seat) : undefined;
  }
  create(seat: TeamSeat): Promise<TeamMember> {
    const key = `${seat.teamId}:${seat.member.id}`, pending = this.creations.get(key); if (pending) return pending;
    const run = this.createOnce(seat).finally(() => this.creations.delete(key)); this.creations.set(key, run); return run;
  }
  private async createOnce(seat: TeamSeat): Promise<TeamMember> {
    await this.ready;
    if (!isTeamSeat(seat) || !this.access.available() || !this.access.supportedProviders().includes(seat.member.providerId)) throw new Error('Provider does not support Team tools on this Host.');
    const existing = this.records.find(item => item.seat.teamId === seat.teamId && item.seat.member.id === seat.member.id);
    if (existing) {
      const previous = existing.seat;
      if (previous.member.providerId !== seat.member.providerId || previous.member.hostId !== seat.member.hostId || previous.member.role !== seat.member.role || JSON.stringify(previous.source) !== JSON.stringify(seat.source)) throw new Error('Team slot identity changed.');
      if (existing.creation !== 'ready') throw new Error('Native creation outcome is unknown. Inspect the Host and abandon this slot before creating another.');
      return existing.seat.member;
    }
    if (this.records.length >= 384) throw new Error('Local Team session capacity reached.');
    seat = structuredClone(seat);
    if (seat.member.role === 'leader') {
      const source = await this.access.acquire(seat.source.providerId, seat.source.nativeSessionId);
      try { seat.member.cwd = source.agent.snapshot().payload.runtimeInfo.cwd; } finally { source.release(); }
      if (!seat.member.cwd) throw new Error('Source working directory is unavailable.');
    }
    const record: LocalSeat = { seat, creation: 'dispatching', receipts: Object.create(null) };
    this.records.push(record); await this.save();
    try {
      seat.member.nativeSessionId = await this.access.create(seat.member.providerId, seat.member.cwd, this.tools(seat));
      record.creation = 'ready'; seat.member.creation = 'ready'; seat.member.activity = 'unknown'; await this.save(); return seat.member;
    } catch (error) { record.creation = 'unknown'; seat.member.creation = 'unknown'; await this.save(); throw error; }
  }
  private tools(seat: TeamSeat): AgentSessionExtensions {
    const { member, teamId } = seat;
    const call = (input: Omit<TeamHostCall, 'teamId' | 'memberId'>) => this.request({ ...input, teamId, memberId: member.id } as TeamHostCall);
    const text = { type: 'string', minLength: 1, maxLength: 16000 }, id = { type: 'string', minLength: 1, maxLength: 256 };
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], execute: (args: Record<string, string>) => Promise<unknown>): AgentSessionTool => ({
      name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, execute: async args => JSON.stringify(await execute(args as Record<string, string>)),
    });
    const tools = [
      tool('read_team', 'Read registered members, responsibilities, progress and message receipts. Accepted input is not completed work.', {}, [], () => call({ action: 'read' })),
      tool('send_team_message', 'Send a task, question or evidence. Reuse operationId for the same request. Delivery is asynchronous; inspect read_team for its receipt. Members may send only to their Leader.', { to: id, operationId: id, text }, ['to', 'operationId', 'text'], args => this.request({ action: 'send', teamId, memberId: member.id, to: args.to!, operationId: args.operationId!, text: args.text! })),
      tool('report_team_progress', 'Record current progress, blocking questions or completion evidence. Also message the Leader when it needs to act.', { summary: { type: 'string', maxLength: 2048 } }, ['summary'], args => this.request({ action: 'report', teamId, memberId: member.id, summary: args.summary! })),
    ];
    if (member.role === 'leader') {
      tools.push(tool('describe_team_member', 'Record responsibilities agreed with the user. Include task scope, environment, permissions, dependencies and expected evidence. This does not dispatch work or grant native permissions.', { target: id, responsibility: { type: 'string', maxLength: 2048 } }, ['target', 'responsibility'], args => this.request({ action: 'describe_member', teamId, memberId: member.id, target: args.target!, responsibility: args.responsibility! })));
      tools.push(tool('read_source_session', 'Read a bounded page from the source conversation for context. The source agent has no Team tools and receives no automatic Team messages.', { before: { type: 'object', properties: { epoch: { type: 'string' }, seq: { type: 'integer' } }, required: ['epoch','seq'], additionalProperties: false } }, [], async args => {
        const source = await this.access.acquire(seat.source.providerId, seat.source.nativeSessionId);
        try { const request = { requestId: randomUUID(), agentId: source.agent.agentId, direction: args.before ? 'before' as const : 'tail' as const, limit: 20, ...(args.before ? { cursor: args.before as unknown as {epoch:string;seq:number} } : {}) }; const page = (await source.agent.fetchTimeline(request)).payload;
          let remaining = 48000; const entries = page.entries.filter(entry => { remaining -= JSON.stringify(entry).length; return remaining >= 0; });
          return { ...page, entries, truncated: entries.length !== page.entries.length }; }
        finally { source.release(); }
      }));
    }
    return { instructions: member.role === 'leader'
      ? `You are the executing Leader of Team ${teamId}, member ${member.id}. Discuss requirements with the user, analyze and implement directly, coordinate registered members, validate evidence and report delivery. Read the source session for necessary context, but do not ask its agent to do your work. Read read_team before delegating. Establish each member's responsibilities with the user and record them with describe_team_member. Remote paths and environments are independent. Shared working directories do not isolate file edits: coordinate changes with the user. Do not assume members remain available. Native permissions still apply. Await responses instead of repeatedly sending the same task.`
      : `You are worker ${member.id} in Team ${teamId}. Read read_team to find your Leader and current responsibility. Directly investigate, implement and verify assigned tasks in your local environment. Return evidence or clarification questions to the Leader with send_team_message. Do not implement until a task is assigned. Do not assume the Leader's paths exist here. Do not delegate to other members or change your authority. Native permissions still apply.`,
      tools: bindAgentSessionTools(tools, () => { if (this.closed || !this.access.available()) throw new Error('Team Host is unavailable.'); }) };
  }
  async tick(): Promise<void> {
    if (this.closed || this.ticking || !this.access.available()) return;
    this.ticking = true;
    try {
      await this.ready;
      if (!this.records.some(record => record.creation === 'ready')) return;
      const value = await this.request({ action: 'poll' });
      if (!Array.isArray(value) || !value.every(isTeam)) throw new Error('Invalid Team catalog.');
      const retained = new Set<string>();
      for (const team of value as Team[]) for (const member of team.members) {
        const record = this.records.find(item => item.seat.teamId === team.id && item.seat.member.id === member.id && item.creation === 'ready');
        if (!record || member.creation !== 'ready' || !member.nativeSessionId) continue;
        const leaseKey = `${team.id}:${member.id}`;
        retained.add(leaseKey);
        try {
          let lease = this.leases.get(leaseKey);
          if (!lease) { lease = await this.access.acquire(member.providerId, member.nativeSessionId); this.leases.set(leaseKey, lease); }
          for (const message of team.messages.filter(item => item.to === member.id && (['queued','dispatching','unknown'].includes(item.status) || item.status === 'accepted' && item.acceptance === 'queued'))) {
            const receipt = record.receipts[message.id];
            if (receipt && receipt.status !== 'dispatching') { await this.settle(team.id, member.id, message.id, receipt); continue; }
            if (message.status === 'dispatching' && !receipt) {
              // A claim survived but its local effect boundary did not. Never infer it was unexecuted.
              await this.settle(team.id, member.id, message.id, { status: 'unknown', error: 'Delivery claim has no local receipt. Inspect this session before resolving.' }); continue;
            }
            if (message.status === 'queued' && team.status === 'active' && idle(lease)) await this.dispatch(record, team, message, lease);
          }
          await this.request({ action: 'presence', teamId: team.id, memberId: member.id, activity: idle(lease) ? 'idle' : 'busy' });
        } catch { /* Pending records remain durable; next poll retries reads and receipts, never uncertain effects. */ }
      }
      for (const [id, lease] of this.leases) if (!retained.has(id)) { lease.release(); this.leases.delete(id); }
    } finally { this.ticking = false; }
  }
  private settle(teamId: string, memberId: string, messageId: string, receipt: {status:string;error?:string;acceptance?:AgentInputAcceptance['disposition']}) {
    return this.request({ action: 'settle', teamId, memberId, messageId, outcome: receipt.status as 'accepted'|'rejected'|'unknown', ...(receipt.acceptance ? {acceptance:receipt.acceptance} : {}), ...(receipt.error ? {error:receipt.error} : {}) });
  }
  private async dispatch(record: LocalSeat, team: Team, message: TeamMessage, lease: RemoteHostSessionLease) {
    await this.request({ action: 'claim', teamId: team.id, memberId: record.seat.member.id, messageId: message.id });
    const receipt: LocalSeat['receipts'][string] = { text: message.text, status: 'dispatching' }; record.receipts[message.id] = receipt; await this.save();
    const sender = team.members.find(member => member.id === message.from);
    const text = `[Team ${team.id}; message ${message.id}; from ${sender?.name ?? message.from}]\n${message.text}`;
    try {
      const onAcceptance = (acceptance: AgentInputAcceptance) => {
        if (!['started','queued','handled'].includes(acceptance.disposition) || this.closed) return;
        if (receipt.acceptance !== 'started' && receipt.acceptance !== 'handled') receipt.acceptance = acceptance.disposition;
        receipt.status = 'accepted'; delete receipt.error;
        void this.save().then(() => this.settle(team.id, record.seat.member.id, message.id, receipt)).catch(() => {});
      };
      const result = await this.access.execute(lease.agent, { operationId: operationId(message.id), kind: 'send_message', parameters: { text }, maximumResultBytes: 4096 }, {
        beforeDispatch: () => { if (this.closed || !this.access.available() || !idle(lease)) throw new AgentOperationRejectedError('team_not_idle', 'Team session is not ready for this input.'); },
        dispatch: () => lease.agent.sendMessage(text, {onAcceptance}),
      });
      if (result && typeof result === 'object' && 'disposition' in result && ['started','queued','handled'].includes(String(result.disposition))) onAcceptance(result as AgentInputAcceptance);
      // A fulfilled SDK operation confirms acceptance without inventing a native disposition.
      if (receipt.status === 'dispatching') receipt.status = 'accepted';
    } catch (error) {
      if (receipt.status !== 'accepted') receipt.status = error instanceof AgentOperationRejectedError || error instanceof OperationCacheError && !['operation_outcome_unknown', 'native_file_limit'].includes(error.code) ? 'rejected' : 'unknown'; receipt.error = errorText(error);
    }
    await this.save(); await this.settle(team.id, record.seat.member.id, message.id, receipt);
  }
  async close() { this.closed = true; clearInterval(this.timer); for (const lease of this.leases.values()) lease.release(); this.leases.clear(); await this.persistence; }
}
