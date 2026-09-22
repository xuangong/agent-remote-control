import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';

export async function stopOwnedProcess(child: ChildProcessWithoutNullStreams, gracefulShutdownMs: number): Promise<void> {
  child.stdin.end();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').then(() => undefined);
  child.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, gracefulShutdownMs); });
  await Promise.race([exited, timeout]);
  if (timer) clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
