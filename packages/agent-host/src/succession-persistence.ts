import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const SUCCESSION_STORE_BYTES = 8 * 1024 * 1024;
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
/** Six escaped bytes per character bound every permitted 512-character identifier. */
export const largestSuccessionId = '\ud800'.repeat(512);
export const largestSuccessionRef = { controllerId: largestSuccessionId, providerId: largestSuccessionId, nativeSessionId: largestSuccessionId };
export class SuccessionCapacityError extends Error {
  readonly code = 'succession_capacity_exceeded';
  constructor() { super('Succession storage capacity limit exceeded.'); }
}
export class SuccessionPublicationRejected extends Error {
  readonly code = 'succession_publication_rejected';
  constructor(cause: unknown) { super('Succession state was not published.', { cause }); }
}
export class SuccessionPublicationUnknown extends Error {
  readonly code = 'succession_publication_unknown';
  constructor(cause: unknown) { super('Succession persistence outcome is unknown. Restart and read durable state before continuing.', { cause }); }
}
/** Fixed-width metadata makes its own serialized size independent of reserved growth. */
export function reservationBytes(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > SUCCESSION_STORE_BYTES) throw new SuccessionCapacityError();
  return String(bytes).padStart(8, '0');
}
export function isReservation(value: unknown): value is string { return typeof value === 'string' && /^\d{8}$/.test(value) && Number(value) <= SUCCESSION_STORE_BYTES; }
export function assertSuccessionCapacity(state: unknown, reservedGrowth: number): void {
  if (jsonBytes(state) + reservedGrowth > SUCCESSION_STORE_BYTES) throw new SuccessionCapacityError();
}
export async function publishSuccessionState(directory: string, name: string, state: unknown): Promise<void> {
  const target = join(directory, name), temporary = `${target}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target); renamed = true;
    try {
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) {
      // Node cannot fsync directories on Windows; other storage failures remain fatal.
      if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  } catch (error) {
    throw renamed ? new SuccessionPublicationUnknown(error) : new SuccessionPublicationRejected(error);
  } finally {
    // A cleanup failure does not change whether the authoritative rename completed.
    await unlink(temporary).catch(() => undefined);
  }
}
