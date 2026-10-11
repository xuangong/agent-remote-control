import { AgentOperationRejectedError, AgentRuntimeError } from '@orchardworks/agent-provider-sdk';
import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_RESULT_RESERVATION_BYTES = 8 * 1024;
const ENTRY_OVERHEAD_BYTES = 256;

export interface OperationDescriptor {
  readonly operationId: string;
  readonly scope: string;
  readonly kind: string;
  readonly target: string;
  readonly parameters: unknown;
}

export interface NativeEffectHandle {
  /** The native call completed, or was definitely rejected without effects. */
  settled(): void;
  /** The call ended without proving native queue/effect disposition. */
  unresolved(): void;
}
export interface NativeEffectReservation {
  /** Promote the reserved slot only immediately before an actual native call. */
  start(): NativeEffectHandle;
  /** Release unused capacity without discarding a pending or unknown native call. */
  release(): void;
}
export interface MutationEntry {
  readonly key: string;
  readonly targets: readonly string[];
  startNativeEffect(target: string): NativeEffectHandle;
  retainAsyncWork(target: string): () => void;
  reserveNativeEffect(target: string): NativeEffectReservation;
}
export interface OperationWork<T> {
  readonly mutationTargets?: readonly string[];
  /** Runs synchronously once, after capacity reservation and before validation. */
  readonly admit?: (entry: MutationEntry) => (() => void) | void;
  readonly run?: (entry: MutationEntry, work: () => Promise<T>) => Promise<T>;
  readonly validate?: () => Promise<void> | void;
  /** Synchronous, side-effect-free admission; may run again after queued preparation. */
  readonly beforeDispatch?: () => void;
  readonly dispatch: (entry: MutationEntry) => Promise<T>;
  readonly maximumResultBytes?: number;
}

export interface OperationCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxResultBytes?: number;
  readonly cleanupIntervalMs?: number;
  readonly now?: () => number;
}

export interface OperationCache {
  execute<T>(descriptor: OperationDescriptor, work: OperationWork<T>): Promise<T>;
  hasUnsettledMutation(target: string): boolean;
  enableMutationTarget(target: string): () => void;
  subscribeMutationSettlement(listener: (target: string) => void): () => void;
  close(): Promise<void>;
}

/** Public, sanitized operation failure. Validation messages may be retained for duplicate requests. */
export class OperationCacheError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'OperationCacheError';
  }
}

type CacheEntry = InFlightEntry | SettledEntry;
interface EntryBase {
  readonly fingerprint: string;
  bytes: number;
  readonly mutation: MutationState;
}
interface MutationState {
  readonly targets: readonly string[];
  readonly metadataBytes: number;
  readonly reservation: number;
  readonly handles: Set<{ target: string; kind: 'native' | 'async' | 'reserved'; state: 'pending' | 'unknown'; pinned: boolean }>;
  resultBytes: number;
  receiptExpired?: true;
}
interface InFlightEntry extends EntryBase {
  readonly state: 'in_flight';
  readonly promise: Promise<unknown>;
}
interface SettledEntry extends EntryBase {
  readonly state: 'completed' | 'rejected' | 'unknown';
  readonly settledAt: number;
  readonly result?: unknown;
  readonly resultUndefined?: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export function createOperationCache(options: OperationCacheOptions = {}): OperationCache {
  const ttlMs = positive(options.ttlMs ?? DEFAULT_TTL_MS, 'ttlMs');
  const maxEntries = positive(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 'maxEntries');
  const maxBytes = positive(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes');
  const maxResultBytes = positive(options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES, 'maxResultBytes');
  const cleanupIntervalMs = positive(options.cleanupIntervalMs ?? Math.min(ttlMs, 60_000), 'cleanupIntervalMs');
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();
  const enabledTargets = new Map<string, number>();
  const maxPinnedEntries = Math.min(125, Math.floor(maxEntries / 8));
  const maxPinnedBytes = Math.min(1024 * 1024, Math.floor(maxBytes / 8));
  const handleBytes = 64;
  const pinned = (entry: CacheEntry) => [...entry.mutation.handles].some(handle => handle.pinned);
  let retainedBytes = 0;
  let closing = false;

  function cleanup(): void {
    const cutoff = validNow(now) - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.state === 'in_flight' || pinned(entry) || entry.settledAt > cutoff) continue;
      entry.mutation.receiptExpired = true;
      entries.delete(key);
      retainedBytes -= entry.bytes;
    }
  }

  const settlementListeners = new Set<(target: string) => void>();
  const unsettled = (target: string) => [...entries.values()].some(entry => entry.mutation.targets.includes(target)
    && (entry.state === 'in_flight' || [...entry.mutation.handles].some(handle => handle.target === target)));
  function notifySettled(targets: readonly string[]): void {
    for (const target of targets) if (!unsettled(target)) for (const listener of settlementListeners) {
      try { listener(target); } catch { /* Subscribers cannot change operation evidence. */ }
    }
  }

  const timer = setInterval(cleanup, cleanupIntervalMs);
  timer.unref?.();

  async function execute<T>(descriptor: OperationDescriptor, work: OperationWork<T>): Promise<T> {
    if (closing) throw new OperationCacheError('operation_cache_closed', 'The operation cache is closing.');
    if (!UUID.test(descriptor.operationId)) {
      throw new OperationCacheError('invalid_operation_id', 'Operation identity must be a UUID.');
    }
    const fingerprint = digest(canonicalJson([descriptor.kind, descriptor.target, descriptor.parameters]));
    const key = `${digest(descriptor.scope)}:${descriptor.operationId.toLowerCase()}`;
    cleanup();
    const existing = entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new OperationCacheError('operation_conflict', 'The operation identity is retained for a different intent.');
      }
      if (existing.state === 'in_flight') return existing.promise as Promise<T>;
      if (existing.state === 'completed') return existing.resultUndefined ? undefined as T : structuredClone(existing.result) as T;
      if (existing.state === 'unknown') {
        throw unknownOutcome(existing.errorCode);
      }
      throw new OperationCacheError(existing.errorCode ?? 'operation_rejected', existing.errorMessage ?? 'The operation was rejected before dispatch.');
    }

    const resultReservation = positive(work.maximumResultBytes ?? Math.min(DEFAULT_RESULT_RESERVATION_BYTES, maxResultBytes), 'maximumResultBytes');
    if (resultReservation > maxResultBytes) {
      throw new OperationCacheError('operation_result_too_large', 'The operation result reservation exceeds the cache limit.');
    }
    const targets = Object.freeze([...new Set(work.mutationTargets ?? [])]);
    if (targets.some(target => typeof target !== 'string' || !target)) throw new OperationCacheError('invalid_operation_target', 'Invalid mutation target.');
    const metadataBytes = targets.reduce((bytes, target) => bytes + Buffer.byteLength(target) + 16, 0);
    const mutation: MutationState = { targets, metadataBytes, reservation: resultReservation, resultBytes: resultReservation, handles: new Set() };
    const reservedBytes = entryBytes(key, resultReservation) + metadataBytes;
    if (entries.size >= maxEntries || retainedBytes + reservedBytes > maxBytes) {
      throw new OperationCacheError('operation_capacity_exceeded', 'The operation cache is full. Wait for retained operations to expire before trying a new mutation.');
    }

    let resolvePending!: (value: T | PromiseLike<T>) => void;
    let rejectPending!: (reason?: unknown) => void;
    const pending = new Promise<T>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    entries.set(key, { state: 'in_flight', fingerprint, bytes: reservedBytes, promise: pending, mutation });
    retainedBytes += reservedBytes;
    const entry = mutationEntry(key, mutation);
    void runOperation(key, fingerprint, reservedBytes, resultReservation, work, entry).then(resolvePending, rejectPending);
    return pending;
  }

  async function runOperation<T>(
    key: string,
    fingerprint: string,
    reservedBytes: number,
    resultReservation: number,
    work: OperationWork<T>,
    entry: MutationEntry,
  ): Promise<T> {
    let release: (() => void) | undefined;
    try {
      try { release = work.admit?.(entry) || undefined; }
      catch (error) { return await perform({ ...work, validate: () => { throw error; } }); }
      let entered = false;
      try { return await (work.run ? work.run(entry, () => { entered = true; return perform(work); }) : perform(work)); }
      catch (error) {
        if (work.run && !entered) return await perform({ ...work, validate: () => { throw error; } });
        throw error;
      }
    } finally { try { release?.(); } catch { /* Cleanup cannot change the published receipt. */ } }

    async function perform(work: OperationWork<T>): Promise<T> {
      try {
        await work.validate?.();
        work.beforeDispatch?.();
      } catch (error) {
        const messageBytes = error instanceof OperationCacheError ? Buffer.byteLength(error.message) : 0;
        const errorMessage = messageBytes > 0 && messageBytes <= Math.min(1024, resultReservation) ? (error as OperationCacheError).message : undefined;
        settle(key, fingerprint, reservedBytes, {
          state: 'rejected', errorCode: safeErrorCode(error), errorMessage, bytes: entryBytes(key, errorMessage ? messageBytes : 0), settledAt: validNow(now),
        });
        throw error;
      }

      let result: T;
      try {
        result = await work.dispatch(entry);
      } catch (error) {
        if (error instanceof AgentOperationRejectedError) {
          const errorCode = safeErrorCode(error);
          settle(key, fingerprint, reservedBytes, {
            state: 'rejected', errorCode, bytes: entryBytes(key, 0), settledAt: validNow(now),
          });
          throw new OperationCacheError(errorCode, 'The operation was rejected without side effects.');
        }
        const errorCode = error instanceof AgentRuntimeError && error.code === 'native_file_limit' ? error.code : undefined;
        settle(key, fingerprint, reservedBytes, {
          state: 'unknown', errorCode, bytes: entryBytes(key, 0), settledAt: validNow(now),
        });
        throw unknownOutcome(errorCode);
      }

      try {
        const resultUndefined = result === undefined;
        const encoded = resultUndefined ? '' : JSON.stringify(result);
        const resultBytes = Buffer.byteLength(encoded);
        if (resultBytes > resultReservation) throw new Error('Result exceeds its retained reservation.');
        const retained = resultUndefined ? undefined : JSON.parse(encoded);
        settle(key, fingerprint, reservedBytes, {
          state: 'completed', result: retained, resultUndefined, bytes: entryBytes(key, resultBytes), settledAt: validNow(now),
        });
        return result;
      } catch {
        settle(key, fingerprint, reservedBytes, {
          state: 'unknown', bytes: entryBytes(key, 0), settledAt: validNow(now),
        });
        throw new OperationCacheError('operation_outcome_unknown', 'The operation result could not be retained after dispatch.');
      }
    }
  }

  function settle(key: string, fingerprint: string, _reservedBytes: number, entry: Omit<SettledEntry, 'fingerprint' | 'mutation'>): void {
    const prior = entries.get(key);
    if (prior?.state !== 'in_flight') return;
    const mutation = prior.mutation;
    mutation.resultBytes = entry.bytes - entryBytes(key, 0);
    entries.set(key, { ...entry, bytes: prior.bytes, fingerprint, mutation });
    account(key); notifySettled(mutation.targets);
  }
  function accountedBytes(key: string, entry: CacheEntry): number {
    const mutation = entry.mutation;
    return entryBytes(key, pinned(entry) ? Math.max(mutation.resultBytes, mutation.reservation) : mutation.resultBytes)
      + mutation.metadataBytes + mutation.handles.size * handleBytes;
  }
  function account(key: string): void {
    const entry = entries.get(key); if (!entry) return;
    const bytes = accountedBytes(key, entry);
    retainedBytes += bytes - entry.bytes; entry.bytes = bytes;
  }
  function mutationEntry(key: string, mutation: MutationState): MutationEntry {
    function retain(target: string, kind: 'native' | 'async' | 'reserved') {
      const entry = entries.get(key);
      if (closing || !entry || entry.mutation !== mutation) throw new AgentOperationRejectedError('operation_cache_closed', 'Mutation evidence is no longer available.');
      if (!mutation.targets.includes(target)) throw new AgentOperationRejectedError('invalid_operation_target', 'Mutation target was not admitted.');
      const handle = { target, kind, state: 'pending' as 'pending' | 'unknown', pinned: enabledTargets.has(target) };
      mutation.handles.add(handle);
      const bytes = accountedBytes(key, entry);
      const pins = [...entries.entries()].filter(([, item]) => pinned(item));
      if (retainedBytes + bytes - entry.bytes > maxBytes || pinned(entry) && (pins.length > maxPinnedEntries
        || pins.reduce((sum, [id, item]) => sum + accountedBytes(id, item), 0) > maxPinnedBytes)) {
        mutation.handles.delete(handle);
        throw new AgentOperationRejectedError('mutation_evidence_capacity', 'Mutation evidence capacity is full. Resolve retained native work before retrying.');
      }
      account(key);
      return {
        handle,
        settled() { if (entries.get(key)?.mutation !== mutation) return; mutation.handles.delete(handle); account(key); notifySettled([target]); },
        unresolved() { handle.state = 'unknown'; },
      };
    }
    return { key, targets: mutation.targets,
      startNativeEffect(target) { const handle = retain(target, 'native'); return { settled: handle.settled, unresolved: handle.unresolved }; },
      retainAsyncWork(target) { const handle = retain(target, 'async'); return () => handle.settled(); },
      reserveNativeEffect(target) {
        const slot = retain(target, 'reserved');
        let released = false;
        let active: NativeEffectHandle | undefined;
        return {
          start() {
            const retained = entries.get(key)?.mutation === mutation;
            // Ordinary receipt expiry does not cancel accepted work or authorize new pinning.
            const ordinaryExpired = mutation.receiptExpired && !slot.handle.pinned && !enabledTargets.has(target);
            if (released || active || closing || (!retained && !ordinaryExpired)) {
              throw new AgentOperationRejectedError('mutation_reservation_unavailable', 'The native effect reservation is unavailable.');
            }
            slot.handle.kind = 'native';
            const effect: NativeEffectHandle = {
              settled() {
                if (active !== effect) return;
                active = undefined;
                if (released) slot.settled();
                else { slot.handle.kind = 'reserved'; slot.handle.state = 'pending'; }
              },
              unresolved() { if (active === effect) slot.unresolved(); },
            };
            active = effect;
            return effect;
          },
          release() { if (released) return; released = true; if (!active) slot.settled(); },
        };
      },
    };
  }

  return {
    execute,
    hasUnsettledMutation(target) {
      cleanup();
      return unsettled(target);
    },
    subscribeMutationSettlement(listener) { settlementListeners.add(listener); return () => { settlementListeners.delete(listener); }; },
    enableMutationTarget(target) {
      enabledTargets.set(target, (enabledTargets.get(target) ?? 0) + 1);
      let released = false;
      return () => { if (released) return; released = true; const count = (enabledTargets.get(target) ?? 1) - 1;
        if (count > 0) enabledTargets.set(target, count); else enabledTargets.delete(target); };
    },
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      await Promise.allSettled([...entries.values()].flatMap((entry) => entry.state === 'in_flight' ? [entry.promise] : []));
      entries.clear();
      enabledTargets.clear(); settlementListeners.clear();
      retainedBytes = 0;
    },
  };
}

function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(normalize);
    if (typeof input === 'object') {
      if (seen.has(input)) throw new OperationCacheError('invalid_operation_intent', 'Operation parameters must not contain cycles.');
      seen.add(input);
      const output = Object.fromEntries(Object.keys(input as Record<string, unknown>).sort().map((key) => {
        const member = (input as Record<string, unknown>)[key];
        if (member === undefined) throw new OperationCacheError('invalid_operation_intent', 'Operation parameters must not contain undefined values.');
        return [key, normalize(member)];
      }));
      seen.delete(input);
      return output;
    }
    throw new OperationCacheError('invalid_operation_intent', 'Operation parameters must be JSON values.');
  };
  return JSON.stringify(normalize(value));
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function entryBytes(key: string, resultBytes: number): number {
  return ENTRY_OVERHEAD_BYTES + Buffer.byteLength(key) + resultBytes;
}
function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'operation_rejected';
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`);
  return value;
}
function validNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new OperationCacheError('operation_clock_invalid', 'Operation cache clock returned an invalid time.');
  return value;
}

function unknownOutcome(cause?: string): OperationCacheError {
  const detail = 'The operation may have reached the native runtime. Inspect native state before creating a new intent.';
  return cause === 'native_file_limit'
    ? new OperationCacheError(cause, `The native runtime reached its file descriptor limit. ${detail}`)
    : new OperationCacheError('operation_outcome_unknown', detail);
}
