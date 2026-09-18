/** A separate process observes pipe EOF even when the Controller cannot run cleanup. */
export const vscodeTunnelSupervisorSource = String.raw`
const { spawn } = require('node:child_process');
const config = JSON.parse(process.argv[1]);
let child;
let stopping = false;
let finished = false;
let childExited = false;
let reported = false;
let result = { code: null, signal: null };
function report(value) {
  if (process.connected) process.send(value, () => {});
}
function signalTree(signal) {
  if (!child || !child.pid) return false;
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
child = spawn(config.executable, args, {
  cwd: config.cwd, env: process.env, detached: true, stdio: ['ignore', 1, 2],
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
