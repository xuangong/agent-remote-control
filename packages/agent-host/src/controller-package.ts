import { filesystemFor, isWindowsSharingError } from '@orchardworks/agent-platform';

/** Publish a verified installation only after Windows releases its directory handles. */
export async function publishControllerPackage(stage: string, target: string, platform = process.platform): Promise<void> {
  try {
    await filesystemFor(platform).rename(stage, target, { retries: 10, delayMs: 250, maxDelayMs: 1000 });
  } catch (error) {
    if (platform !== 'win32' || !isWindowsSharingError(error)) throw error;
    throw new Error('The Controller update directory is still locked by another process. The running version is unchanged. Close programs using the update directory, then retry.', { cause: error });
  }
}
