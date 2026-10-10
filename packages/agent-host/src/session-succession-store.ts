import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPrimaryRole, isPreparedSuccession, isSuccessionParticipant, isSuccessionRecord, isSuccessionRequest, nativeSessionRefKey,
  type PrimaryRole, type SuccessionParticipant, type SuccessionPhase, type SuccessionRecord, type SuccessionRequest } from '@orchardworks/agent-remote-protocol';

export interface SuccessionRoleState {
  role: PrimaryRole;
  operations: SuccessionRecord[];
  associationRevision: number;
  participants: SuccessionParticipant[];
}
interface StoreState { version: 1; roles: SuccessionRoleState[] }
type Advance = Pick<SuccessionRecord, 'phase'> & Partial<Pick<SuccessionRecord, 'to' | 'prepared' | 'failureCode'>>;
const terminal = (phase: SuccessionPhase) => ['committed', 'rejected', 'cancelled'].includes(phase);
const fingerprint = (request: SuccessionRequest) => JSON.stringify([request.operationId, request.roleId, request.expectedRevision, nativeSessionRefKey(request.from), request.targetProviderId ?? request.from.providerId]);
const maxBytes = 8 * 1024 * 1024;

/** One owning Controller serializes role decisions; publication follows atomic file replacement. */
export class SessionSuccessionStore {
  readonly ready: Promise<void>;
  private state: StoreState = { version: 1, roles: [] };
  private tail: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private revision = 0;
  constructor(private readonly directory: string) { this.ready = this.restore(); }
  get generation(): number { return this.revision; }

  read(roleId: string): SuccessionRoleState {
    if (!this.loaded) throw new Error('Session succession store is not ready.');
    return structuredClone(this.findRole(this.state, roleId));
  }
  operation(operationId: string): SuccessionRecord {
    if (!this.loaded) throw new Error('Session succession store is not ready.');
    return structuredClone(this.findOperation(this.state, operationId));
  }
  all(): SuccessionRoleState[] {
    if (!this.loaded) throw new Error('Session succession store is not ready.');
    return structuredClone(this.state.roles);
  }

  createRole(role: PrimaryRole): Promise<PrimaryRole> {
    const input = structuredClone(role);
    return this.mutate(state => {
      if (!isPrimaryRole(input) || input.revision !== 1 || nativeSessionRefKey(input.origin) !== nativeSessionRefKey(input.current)) throw new Error('Invalid initial primary role.');
      if (state.roles.some(item => item.role.id === input.id || nativeSessionRefKey(item.role.current) === nativeSessionRefKey(input.current))) throw new Error('Primary role already exists.');
      if (state.roles.length >= 1024) throw new Error('Primary role storage is full.');
      state.roles.push({ role: input, operations: [], associationRevision: 0, participants: [] }); return input;
    });
  }

  /** Called with Controller-verified relationships, never an unverified browser participant list. */
  setParticipants(roleId: string, expectedRevision: number, associationRevision: number, participants: SuccessionParticipant[]): Promise<SuccessionRoleState> {
    const input = structuredClone(participants);
    return this.mutate(state => {
      const item = this.findRole(state, roleId);
      if (item.role.revision !== expectedRevision || item.associationRevision !== associationRevision) throw new Error('Primary role association revision changed.');
      if (item.operations.some(op => !terminal(op.phase))) throw new Error('Primary role is reserved by a succession in progress.');
      if (JSON.stringify(item.participants) === JSON.stringify(input)) return item;
      if (item.associationRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Primary association revision is exhausted.');
      item.participants = input; item.associationRevision++; return item;
    });
  }

  begin(request: SuccessionRequest): Promise<SuccessionRecord> {
    const input = structuredClone(request);
    return this.mutate(state => {
      if (!isSuccessionRequest(input)) throw new Error('Invalid succession request.');
      const prior = state.roles.flatMap(item => item.operations).find(op => op.operationId === input.operationId);
      if (prior) {
        if (fingerprint(prior) !== fingerprint(input)) throw new Error('Succession operation identity conflict.');
        return prior;
      }
      const item = this.findRole(state, input.roleId);
      if (item.role.revision !== input.expectedRevision || nativeSessionRefKey(item.role.current) !== nativeSessionRefKey(input.from)) throw new Error('Primary role revision changed.');
      if (item.operations.some(op => !terminal(op.phase))) throw new Error('Primary role is reserved by a succession in progress.');
      if (item.operations.length >= 512) throw new Error('Succession history is full.');
      const now = new Date().toISOString();
      const record: SuccessionRecord = { ...input, phase: 'preparing', startedAt: now, updatedAt: now };
      item.operations.push(record); return record;
    });
  }

  /** Unknown outcomes may advance only after the coordinator has reconciled their saved phase. */
  advance(operationId: string, expectedPhase: SuccessionPhase, change: Advance): Promise<SuccessionRecord> {
    const patch = structuredClone(change);
    return this.mutate(state => {
      const record = this.findOperation(state, operationId);
      if (record.phase !== expectedPhase) throw new Error('Succession phase changed.');
      if (terminal(record.phase) || patch.phase === 'committed') throw new Error('Invalid succession phase transition.');
      if (record.phase === 'unknown') {
        if (patch.phase !== record.resumePhase) throw new Error('Reconcile the unknown succession phase before continuing.');
        delete record.resumePhase;
      } else if (patch.phase === 'unknown') {
        record.resumePhase = record.phase as SuccessionRecord['resumePhase'];
      } else {
        const next: Partial<Record<SuccessionPhase, SuccessionPhase>> = { preparing: 'quiescing', quiescing: 'transferring', transferring: 'ready' };
        if (!['rejected', 'cancelled'].includes(patch.phase) && next[record.phase] !== patch.phase) throw new Error('Invalid succession phase transition.');
      }
      if (record.to && patch.to && nativeSessionRefKey(record.to) !== nativeSessionRefKey(patch.to)) throw new Error('Succession target cannot change.');
      if (patch.to && nativeSessionRefKey(patch.to) === nativeSessionRefKey(record.from)) throw new Error('Succession target is the same session.');
      Object.assign(record, patch, { updatedAt: new Date().toISOString() });
      this.validateRecord(record); return record;
    });
  }

  commit(operationId: string, expectedGeneration?: number): Promise<SuccessionRecord> {
    return this.mutate(state => {
      if (expectedGeneration !== undefined && expectedGeneration !== this.generation) throw new Error('Succession state changed during commit verification.');
      const record = this.findOperation(state, operationId);
      if (record.phase === 'committed') return record;
      if (record.to && record.to.providerId !== (record.targetProviderId ?? record.from.providerId)) throw new Error('Succession target provider does not match the request.');
      if (record.phase !== 'ready' || !record.prepared || !record.to) throw new Error('Succession is not ready to commit.');
      const item = this.findRole(state, record.roleId);
      if (item.role.revision !== record.expectedRevision || nativeSessionRefKey(item.role.current) !== nativeSessionRefKey(record.from)) throw new Error('Primary role revision changed.');
      if (item.role.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Primary role revision is exhausted.');
      if (record.prepared.associationRevision !== item.associationRevision || JSON.stringify(record.prepared.participants) !== JSON.stringify(item.participants)) throw new Error('Primary role association snapshot changed.');
      if (state.roles.some(other => other !== item && nativeSessionRefKey(other.role.current) === nativeSessionRefKey(record.to!))) throw new Error('Succession target already executes another role.');
      item.role.current = structuredClone(record.to);
      item.role.workspace = structuredClone(record.prepared.workspace);
      item.role.revision++;
      record.phase = 'committed'; record.committedRevision = item.role.revision;
      record.updatedAt = new Date().toISOString(); delete record.resumePhase;
      return record;
    });
  }

  private findRole(state: StoreState, roleId: string): SuccessionRoleState {
    const item = state.roles.find(item => item.role.id === roleId);
    if (!item) throw new Error('Primary role was not found.');
    return item;
  }
  private findOperation(state: StoreState, operationId: string): SuccessionRecord {
    const record = state.roles.flatMap(item => item.operations).find(op => op.operationId === operationId);
    if (!record) throw new Error('Succession operation was not found.');
    return record;
  }
  private mutate<T>(change: (state: StoreState) => T): Promise<T> {
    const next = this.tail.catch(() => undefined).then(async () => {
      await this.ready;
      const state = structuredClone(this.state), result = change(state);
      this.validate(state);
      if (JSON.stringify(state) !== JSON.stringify(this.state)) { await this.write(state); this.state = state; this.revision++; }
      return structuredClone(result);
    });
    this.tail = next; return next;
  }
  private validateRecord(record: SuccessionRecord): void {
    if (!isSuccessionRecord(record)) throw new Error('Invalid succession record.');
    if (record.to && nativeSessionRefKey(record.to) === nativeSessionRefKey(record.from)) throw new Error('Invalid succession target.');
    if (['transferring', 'ready', 'committed'].includes(record.phase) && !record.to) throw new Error('Succession target is missing.');
    if (record.phase === 'unknown' ? !record.resumePhase : record.resumePhase !== undefined) throw new Error('Invalid unknown succession phase.');
    if (['ready', 'committed'].includes(record.phase) && !record.prepared) throw new Error('Succession preparation is missing.');
    if (record.phase === 'committed' ? record.committedRevision !== record.expectedRevision + 1 : record.committedRevision !== undefined) throw new Error('Invalid succession commit revision.');
    if (record.prepared) {
      const prepared = record.prepared;
      if (!isPreparedSuccession(prepared) || fingerprint(prepared) !== fingerprint(record) || !record.to || nativeSessionRefKey(prepared.to) !== nativeSessionRefKey(record.to)) throw new Error('Succession preparation does not match the operation.');
      const relations = new Set<string>();
      for (const participant of prepared.participants) {
        if (relations.has(participant.relationId)) throw new Error('Duplicate succession participant.');
        relations.add(participant.relationId);
      }
    }
  }
  private validate(state: StoreState): void {
    if (!state || state.version !== 1 || !Array.isArray(state.roles) || state.roles.length > 1024) throw new Error('Unsupported succession storage format/version.');
    const roles = new Set<string>(), operations = new Set<string>(), executors = new Set<string>();
    for (const item of state.roles) {
      if (!item || !isPrimaryRole(item.role) || !Array.isArray(item.operations) || item.operations.length > 512 || roles.has(item.role.id)) throw new Error('Invalid primary role record.');
      if (!Number.isSafeInteger(item.associationRevision) || item.associationRevision < 0 || !Array.isArray(item.participants)
        || item.participants.length > 1024 || !item.participants.every(isSuccessionParticipant)
        || new Set(item.participants.map(participant => participant.relationId)).size !== item.participants.length) throw new Error('Invalid primary role participants.');
      roles.add(item.role.id);
      const executor = nativeSessionRefKey(item.role.current);
      if (executors.has(executor)) throw new Error('Duplicate primary executor.');
      executors.add(executor);
      let current = item.role.origin, revision = 1, pending = 0;
      for (const op of item.operations) {
        this.validateRecord(op);
        if (op.roleId !== item.role.id || operations.has(op.operationId) || op.expectedRevision !== revision || nativeSessionRefKey(op.from) !== nativeSessionRefKey(current)) throw new Error('Invalid succession history.');
        operations.add(op.operationId);
        if (!terminal(op.phase)) pending++;
        if (op.phase === 'committed') { current = op.to!; revision++; }
      }
      if (pending > 1 || revision !== item.role.revision || nativeSessionRefKey(current) !== executor) throw new Error('Invalid current succession state.');
    }
  }
  private async restore(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let text: string;
    try { text = await readFile(join(this.directory, 'state.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.loaded = true; return; }
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Succession storage size limit exceeded.');
    const state = JSON.parse(text) as StoreState; this.validate(state);
    let changed = false;
    for (const item of state.roles) for (const op of item.operations) if (!terminal(op.phase) && op.phase !== 'unknown') {
      op.resumePhase = op.phase as SuccessionRecord['resumePhase']; op.phase = 'unknown';
      op.failureCode = 'succession_recovery_required'; changed = true;
    }
    if (changed) await this.write(state);
    this.state = state; this.loaded = true; this.revision++;
  }
  private async write(state: StoreState): Promise<void> {
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Succession storage size limit exceeded.');
    const target = join(this.directory, 'state.json'), temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
}
