import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isTpmWork, type TpmWork } from '@orchardworks/agent-remote-protocol';
import { initialTpmTodo } from './tpm-role.js';

export interface TpmRecord {
  version: 1;
  work: TpmWork;
  createKey: string;
  createFingerprint: string;
  creation: 'prepared' | 'dispatching' | 'accepted' | 'unknown' | 'abandoned';
  requirement: string;
  documentHistory?: Array<{ revision: number; document: string; acceptance: string; evidence?: string[] }>;
  dirty: boolean;
  changeVersion?: number;
  reviewVersion?: number;
  lastReviewAt: number;
  reviewIntentId?: string;
  reviewObservedRunning?: boolean;
  approvedSpecification?: string;
  actions: Record<string, { fingerprint: string; revision: number }>;
}

const OUTBOX_MAX_BYTES = 512 * 1024;
function boundOutbox(record: TpmRecord): void {
  const outbox = record.work.outbox;
  if (!outbox) return;
  while (Buffer.byteLength(JSON.stringify(outbox)) > OUTBOX_MAX_BYTES) {
    const index = outbox.findIndex(intent => ['accepted', 'rejected'].includes(intent.status) && intent.id !== record.reviewIntentId);
    if (index < 0) throw new Error('The pending message size budget is full. Resolve pending communication before adding more.');
    outbox.splice(index, 1);
  }
}

/** One Controller owns this store. Atomic replacement precedes publication to readers. */
export class TpmStore {
  readonly ready: Promise<void>;
  private records = new Map<string, TpmRecord>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) { this.ready = this.restore(); }
  all(): TpmRecord[] { return structuredClone([...this.records.values()]); }
  get(id: string): TpmRecord {
    const record = this.records.get(id);
    if (!record) throw new Error('TPM work was not found.');
    return structuredClone(record);
  }
  insert(record: TpmRecord): Promise<TpmRecord> {
    return this.serial(async () => {
      if (this.records.has(record.work.id)) throw new Error('TPM work already exists.');
      await this.write(record); this.records.set(record.work.id, structuredClone(record));
      return structuredClone(record);
    });
  }
  update(id: string, revision: number | undefined, change: (record: TpmRecord) => void): Promise<TpmRecord> {
    return this.serial(async () => {
      const record = this.get(id);
      if (revision !== undefined && record.work.revision !== revision) throw new Error('TPM work changed. Refresh before applying this change.');
      const artifact = { revision: record.work.documentRevision ?? record.work.revision, document: record.work.document, acceptance: record.work.acceptance, evidence: structuredClone(record.work.evidence) };
      change(record);
      if (artifact.document !== record.work.document || artifact.acceptance !== record.work.acceptance || JSON.stringify(artifact.evidence) !== JSON.stringify(record.work.evidence)) {
        const history = record.documentHistory ??= []; history.push(artifact);
        if (history.length > 20) history.splice(0, history.length - 20);
        record.work.documentRevision = record.work.revision + 1;
      }
      record.work.revision += 1; record.work.updatedAt = new Date().toISOString();
      await this.write(record); this.records.set(id, structuredClone(record)); return structuredClone(record);
    });
  }
  async flush(): Promise<void> { await this.ready; await this.tail.catch(() => undefined); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(() => this.ready).then(work);
    this.tail = next; return next;
  }
  private async restore(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
      const record: TpmRecord = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
      if (record.version !== 1 || !isTpmWork(record.work) || `${record.work.id}.json` !== name
        || typeof record.createKey !== 'string' || typeof record.requirement !== 'string' || !record.actions
        || !['prepared', 'dispatching', 'accepted', 'unknown', 'abandoned'].includes(record.creation)) throw new Error(`Invalid TPM record: ${name}`);
      let uncertain = false; let migrated = record.work.documentRevision === undefined;
      if (!record.work.todo && record.work.phase !== 'completed') { record.work.todo = initialTpmTodo(); migrated = true; }
      record.work.documentRevision ??= record.work.revision;
      // Read older local records without retaining their duplicated public snapshots.
      for (const [key, receipt] of Object.entries(record.actions)) {
        const legacy = receipt as typeof receipt & { result?: TpmWork };
        if (legacy.result) { record.actions[key] = { fingerprint: legacy.fingerprint, revision: legacy.result.revision }; migrated = true; }
      }
      if (record.creation === 'prepared') { record.creation = 'unknown'; uncertain = true; }
      if (record.creation === 'dispatching') { record.creation = 'unknown'; uncertain = true; }
      for (const intent of record.work.outbox ?? []) if (intent.status === 'dispatching') { intent.status = 'unknown'; uncertain = true; }
      record.work.creationStatus = record.creation;
      if (uncertain) record.work.health = 'An operation outcome is unknown after Controller restart. Resolve it before continuing.';
      const previousOutbox = JSON.stringify(record.work.outbox); boundOutbox(record);
      if (uncertain || migrated || previousOutbox !== JSON.stringify(record.work.outbox)) await this.write(record);
      this.records.set(record.work.id, record);
    }
  }
  private async write(record: TpmRecord): Promise<void> {
    if (!record.work.todo && record.work.phase !== 'completed') record.work.todo = initialTpmTodo();
    record.work.creationStatus = record.creation;
    record.work.documentRevision ??= record.work.revision;
    boundOutbox(record);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(record.work.id) || !isTpmWork(record.work)) throw new Error('Invalid TPM work record.');
    const target = join(this.directory, `${record.work.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, target); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
}
