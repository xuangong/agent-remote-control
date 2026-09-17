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

export interface OperationWork<T> {
  readonly validate?: () => Promise<void> | void;
  readonly dispatch: () => Promise<T>;
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
  close(): Promise<void>;
}

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
}

export function createOperationCache(options: OperationCacheOptions = {}): OperationCache {
  const ttlMs = positive(options.ttlMs ?? DEFAULT_TTL_MS, 'ttlMs');
  const maxEntries = positive(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 'maxEntries');
  const maxBytes = positive(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes');
  const maxResultBytes = positive(options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES, 'maxResultBytes');
  const cleanupIntervalMs = positive(options.cleanupIntervalMs ?? Math.min(ttlMs, 60_000), 'cleanupIntervalMs');
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();
  let retainedBytes = 0;
  let closing = false;

  function cleanup(): void {
    const cutoff = validNow(now) - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.state === 'in_flight' || entry.settledAt > cutoff) continue;
      entries.delete(key);
      retainedBytes -= entry.bytes;
    }
  }

  const timer = setInterval(cleanup, cleanupIntervalMs);
  timer.unref?.();

  async function execute<T>(descriptor: OperationDescriptor, work: OperationWork<T>): Promise<T> {
    if (closing) throw new OperationCacheError('operation_cache_closed', 'The Host operation cache is closing.');
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
        throw new OperationCacheError('operation_outcome_unknown', 'The operation may have reached the native runtime. Inspect native state before creating a new intent.');
      }
      throw new OperationCacheError(existing.errorCode ?? 'operation_rejected', 'The operation was rejected before dispatch.');
    }

    const resultReservation = positive(work.maximumResultBytes ?? Math.min(DEFAULT_RESULT_RESERVATION_BYTES, maxResultBytes), 'maximumResultBytes');
    if (resultReservation > maxResultBytes) {
      throw new OperationCacheError('operation_result_too_large', 'The operation result reservation exceeds the cache limit.');
    }
    const reservedBytes = entryBytes(key, resultReservation);
    if (entries.size >= maxEntries || retainedBytes + reservedBytes > maxBytes) {
      throw new OperationCacheError('operation_capacity_exceeded', 'The Host operation cache is full. Wait for retained operations to expire before trying a new mutation.');
    }

    let resolvePending!: (value: T | PromiseLike<T>) => void;
    let rejectPending!: (reason?: unknown) => void;
    const pending = new Promise<T>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    entries.set(key, { state: 'in_flight', fingerprint, bytes: reservedBytes, promise: pending });
    retainedBytes += reservedBytes;
    void runOperation(key, fingerprint, reservedBytes, resultReservation, work).then(resolvePending, rejectPending);
    return pending;
  }

  async function runOperation<T>(
    key: string,
    fingerprint: string,
    reservedBytes: number,
    resultReservation: number,
    work: OperationWork<T>,
  ): Promise<T> {
    try {
      await work.validate?.();
    } catch (error) {
      settle(key, fingerprint, reservedBytes, {
        state: 'rejected', errorCode: safeErrorCode(error), bytes: entryBytes(key, 0), settledAt: validNow(now),
      });
      throw error;
    }

    let result: T;
    try {
      result = await work.dispatch();
    } catch {
      settle(key, fingerprint, reservedBytes, {
        state: 'unknown', bytes: entryBytes(key, 0), settledAt: validNow(now),
      });
      throw new OperationCacheError('operation_outcome_unknown', 'The operation may have reached the native runtime. Inspect native state before creating a new intent.');
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

  function settle(key: string, fingerprint: string, reservedBytes: number, entry: Omit<SettledEntry, 'fingerprint'>): void {
    if (entries.get(key)?.state !== 'in_flight') return;
    retainedBytes += entry.bytes - reservedBytes;
    entries.set(key, { ...entry, fingerprint });
  }

  return {
    execute,
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      await Promise.allSettled([...entries.values()].flatMap((entry) => entry.state === 'in_flight' ? [entry.promise] : []));
      entries.clear();
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
