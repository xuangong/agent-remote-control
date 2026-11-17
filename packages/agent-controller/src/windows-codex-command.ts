import { spawn } from 'node:child_process';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWindowsCodexDaemon, requestWindowsCodexDaemon, windowsCodexDaemonDirectory } from '@orchardworks/agent-provider-codex';

export async function manageWindowsCodexDaemon(action: string, executable: string, home: string, env: NodeJS.ProcessEnv): Promise<number> {
  if (!['start', 'restart', 'stop', 'status', 'version', '--help', '-h'].includes(action)) throw new Error('Use codex daemon start, restart, stop, or status.');
  if (['--help', '-h'].includes(action)) { process.stdout.write('Windows shared Codex daemon: start | restart | stop | status\n'); return 0; }
  const directory = windowsCodexDaemonDirectory(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'lifecycle.lock');
  try { await mkdir(lock); }
  catch { throw new Error(`Another shared Codex lifecycle command owns ${lock}. Remove a stale lock only after checking that no lifecycle command is running.`); }
  try {
    let state = await readWindowsCodexDaemon(home);
    let live = false;
    if (state) {
      try { live = (await requestWindowsCodexDaemon(state, 'status')).pid === state.pid; }
      catch {
        try { process.kill(state.pid, 0); throw new Error('Saved shared Codex manager is alive but unavailable. Inspect its log before retrying.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    if (action === 'status' || action === 'version') {
      process.stdout.write(JSON.stringify(live && state ? { running: true, pid: state.pid, nativePid: state.nativePid, url: state.url, version: state.version }
        : { running: false }) + '\n');
      return live ? 0 : 3;
    }
    if (live && state && (action === 'stop' || action === 'restart')) {
      await requestWindowsCodexDaemon(state, 'stop');
      const deadline = Date.now() + 10000;
      while ((await readWindowsCodexDaemon(home))?.pid === state.pid) {
        if (Date.now() >= deadline) throw new Error('Shared Codex daemon did not stop within its deadline.');
        await new Promise(done => setTimeout(done, 100));
      }
      live = false;
    }
    if (action === 'stop') { process.stdout.write('Windows shared Codex daemon is stopped.\n'); return 0; }
    if (live) { process.stdout.write('Windows shared Codex daemon is already running.\n'); return 0; }
    const log = await open(join(directory, 'daemon.log'), 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), '_codex-daemon', executable, home], {
        env, cwd: home, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
      });
      await new Promise<void>((done, reject) => { child!.once('spawn', done); child!.once('error', reject); });
      child.unref();
    } finally { await log.close(); }
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      state = await readWindowsCodexDaemon(home);
      if (state && state.pid === child.pid) {
        try { await requestWindowsCodexDaemon(state, 'status'); process.stdout.write('Windows shared Codex daemon started.\n'); return 0; } catch {}
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`Shared Codex daemon did not become ready. Inspect ${join(directory, 'daemon.log')}.`);
  } finally { await rm(lock, { recursive: true, force: true }); }
}
