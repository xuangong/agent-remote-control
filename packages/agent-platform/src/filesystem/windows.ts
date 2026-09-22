import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { PlatformFilesystem } from './types.js';

export const windowsFilesystem: PlatformFilesystem = {
  // Node cannot flush Windows directory handles. Callers flush files before rename.
  async syncDirectory() {},
  async rename(source, target, policy) {
    for (let attempt = 0; ; attempt++) {
      try { await rename(source, target); return; }
      catch (error) {
        if (attempt >= policy.retries || !isWindowsSharingError(error)) throw error;
        await delay(Math.min(policy.delayMs * (attempt + 1), policy.maxDelayMs));
      }
    }
  },
};

export function isWindowsSharingError(error: unknown): boolean {
  return ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException | null)?.code ?? '');
}
