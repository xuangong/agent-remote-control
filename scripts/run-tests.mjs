import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'unit';
const commands = {
  setup: ['exec', 'node', '--test', '--test-timeout=15000', 'scripts/dsh-debug.test.mjs', 'scripts/start.test.mjs'],
  unit: ['-r', 'run', 'test', '--hookTimeout=30000'],
  e2e: ['--filter', 'agent-remote-lab', 'exec', 'playwright', 'test', '--timeout=30000', '--global-timeout=480000', ...process.argv.slice(3)],
  conformance: ['--filter', 'agent-remote-lab', 'run', 'test:conformance'],
};
if (!(mode in commands)) throw new Error(`Unknown test suite: ${mode}`);
const child = spawn('pnpm', commands[mode], { stdio: 'inherit', detached: process.platform !== 'win32' });
function stop(signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
const deadline = setTimeout(() => {
  process.stderr.write(`${mode} suite exceeded its 540 second deadline.\n`);
  stop('SIGKILL');
}, 540_000);
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
child.once('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
child.once('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
