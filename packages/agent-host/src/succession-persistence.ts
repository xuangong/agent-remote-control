import { open, rename, unlink, type FileHandle } from 'node:fs/promises';
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
/** Preserve the operation failure first when releasing its file handle also fails. */
export async function withSuccessionFile(file: FileHandle, operation: () => Promise<void>): Promise<void> {
  let failed = false, failure: unknown;
  try { await operation(); } catch (error) { failed = true; failure = error; }
  try { await file.close(); } catch (error) {
    if (failed) throw new AggregateError([failure, error], 'Succession file operation and close failed.', { cause: failure });
    throw error;
  }
  if (failed) throw failure;
}
export async function syncSuccessionDirectory(directory: string): Promise<void> {
  let parent: FileHandle;
  try { parent = await open(directory, 'r'); }
  catch (error) { if (unsupportedDirectorySync(error)) return; throw error; }
  try {
    await withSuccessionFile(parent, async () => {
      try { await parent.sync(); } catch (error) { if (!unsupportedDirectorySync(error)) throw error; }
    });
  } catch (error) { if (!unsupportedDirectorySync(error)) throw error; }
}
function unsupportedDirectorySync(error: unknown): boolean {
  // This existing Windows exception does not certify crash or power-loss behavior.
  return process.platform === 'win32' && ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}
export async function publishSuccessionState(directory: string, name: string, state: unknown): Promise<void> {
  const target = join(directory, name), temporary = `${target}.${randomUUID()}.tmp`;
  let renameAttempted = false, failure: SuccessionPublicationRejected | SuccessionPublicationUnknown | undefined;
  try {
    const file = await open(temporary, 'wx', 0o600);
    await withSuccessionFile(file, async () => { await file.writeFile(JSON.stringify(state)); await file.sync(); });
    renameAttempted = true; await rename(temporary, target);
    await syncSuccessionDirectory(directory);
  } catch (error) {
    failure = renameAttempted ? new SuccessionPublicationUnknown(error) : new SuccessionPublicationRejected(error);
  }
  try { await unlink(temporary); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && failure) {
      const cause = new AggregateError([failure.cause, error], 'Succession publication and cleanup failed.', { cause: failure.cause });
      failure = failure instanceof SuccessionPublicationUnknown ? new SuccessionPublicationUnknown(cause) : new SuccessionPublicationRejected(cause);
    }
  }
  if (failure) throw failure;
}
