import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { stopOwnedProcess } from './posix.js';
import { stopOwnedProcessTree } from './windows.js';

/** Only use for a child owned by this client, never an external shared daemon. */
export function disposeOwnedProcess(child: ChildProcessWithoutNullStreams, gracefulShutdownMs: number): Promise<void> {
  return process.platform === 'win32' ? stopOwnedProcessTree(child) : stopOwnedProcess(child, gracefulShutdownMs);
}
