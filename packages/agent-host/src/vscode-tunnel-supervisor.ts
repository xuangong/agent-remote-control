import { windowsJobSource } from './platform/processes/windows-job.js';

/** A separate process observes pipe EOF even when the Controller cannot run cleanup. */
export const vscodeTunnelSupervisorSource = String.raw`
const { spawn, execFileSync } = require('node:child_process');
const { join } = require('node:path');
const config = JSON.parse(process.argv[1]);
let child;
let stopping = false;
let finished = false;
let childExited = false;
let reported = false;
let windowsStopped = false;
let result = { code: null, signal: null };
function report(value) {
  if (process.connected) process.send(value, () => {});
}
function signalTree(signal) {
  if (!child || !child.pid) return false;
  if (process.platform === 'win32') {
    if (windowsStopped || childExited) return false;
    windowsStopped = true;
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 3000, windowsHide: true, stdio: 'ignore' }); } catch {}
    return true;
  }
  try { process.kill(-child.pid, signal); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    try { return child.kill(signal); } catch { return false; }
  }
}
function finish() {
  if (finished) return;
  finished = true;
  signalTree('SIGKILL');
  const complete = () => {
    if (reported) return;
    reported = true;
    const exit = () => process.exit(result.code === 0 ? 0 : 1);
    if (process.connected) process.send({ type: 'exit', ...result }, exit);
    else exit();
  };
  if (childExited || !child || !child.pid) complete();
  else { child.once('exit', complete); setTimeout(complete, 1000); }
}
function stop() {
  if (stopping) return;
  stopping = true;
  signalTree('SIGTERM');
  setTimeout(finish, config.stopTimeoutMs);
}
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdout.on('error', stop);
process.stderr.on('error', stop);
process.stdin.resume();
const args = config.args.map(value => value === '__ARC_PARENT_PID__' ? String(process.pid) : value);
let executable = config.executable;
let nativeArgs = args;
if (process.platform === 'win32') {
  const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  const literal = value => "'" + value.replace(/'/g, "''") + "'";
  const source = ${JSON.stringify(windowsJobSource)};
  const script = '$ErrorActionPreference = "Stop"; Add-Type -TypeDefinition ' + literal(source)
    + '; exit [ControllerJob]::Run(' + literal(executable) + ',' + literal([executable, ...args].map(quote).join(' ')) + ',' + literal(config.cwd) + ',' + process.pid + ')';
  executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  nativeArgs = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}
child = spawn(executable, nativeArgs, {
  cwd: config.cwd, env: process.env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 1, 2],
});
child.once('spawn', () => report({ type: 'spawn', pid: child.pid }));
child.once('error', () => { report({ type: 'spawnError' }); finish(); });
child.once('exit', (code, signal) => {
  childExited = true;
  result = { code, signal };
  if (!signalTree('SIGTERM')) finish();
  else stop();
});
if (config.timeoutMs) setTimeout(stop, config.timeoutMs);
`;
