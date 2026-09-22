import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** npm entry points may own a native server below the JavaScript wrapper. */
export async function stopOwnedProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) { child.stdin.end(); return; }
  await new Promise<void>((resolve, reject) => {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, error => {
      if (error && child.exitCode === null && child.signalCode === null) reject(error);
      else resolve();
    });
  });
}
