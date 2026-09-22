import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Publish a verified installation only after Windows releases its directory handles. */
export async function publishControllerPackage(stage: string, target: string, platform = process.platform): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(stage, target); return; }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      if (attempt >= 10) throw new Error('The Controller update directory is still locked by another process. The running version is unchanged. Close programs using the update directory, then retry.', { cause: error });
      // npm's child processes and Windows scanners can outlive the package smoke check.
      await delay(Math.min(250 * (attempt + 1), 1000));
    }
  }
}
