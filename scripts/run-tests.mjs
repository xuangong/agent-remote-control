import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'unit';
if (mode === 'codex-shared' && !process.env.AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE) throw new Error('Set AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE to the native Codex executable for shared-runtime tests.');
const commands = {
  'preview-browser': ['--filter', '@agent-remote-controller/agent-remote-lab', 'exec', 'vitest', 'run', '--config=vitest.preview.config.ts', '--testTimeout=30000', '--hookTimeout=15000'],
  'codex-shared': ['--filter', '@agent-remote-controller/agent-provider-codex', 'exec', 'vitest', 'run', 'src/shared-runtime.local.test.ts', '--testTimeout=30000', '--hookTimeout=15000', '--maxWorkers=1'],
  'host-package': ['exec', 'node', '--test', '--test-timeout=180000', 'scripts/agent-host-cli.test.mjs', 'scripts/agent-host-package.test.mjs'],
  cloudflare: ['--filter', '@agent-remote-controller/agent-remote-cloudflare', 'run', 'test', '--hookTimeout=30000'],
  copilot: ['--filter', '@agent-remote-controller/agent-provider-copilot', 'run', 'test', '--hookTimeout=30000'],
  setup: ['exec', 'node', '--test', '--test-timeout=15000', 'scripts/dsh-debug.test.mjs', 'scripts/start.test.mjs', 'scripts/relay-local.test.mjs'],
  unit: ['-r', 'run', 'test', '--hookTimeout=30000'],
  e2e: ['--filter', '@agent-remote-controller/agent-remote-lab', 'exec', 'playwright', 'test', '--timeout=30000', '--global-timeout=480000', ...process.argv.slice(3)],
  conformance: ['--filter', '@agent-remote-controller/agent-remote-lab', 'run', 'test:conformance'],
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
