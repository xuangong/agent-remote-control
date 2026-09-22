import { spawn } from 'node:child_process';
import { packageManager } from './lib/package-manager.mjs';

const mode = process.argv[2] ?? 'unit';
if (mode === 'codex-shared' && !process.env.AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE) throw new Error('Set AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE to the native Codex executable for shared-runtime tests.');
const commands = {
  'image-input': ['--filter', '@orchardworks/agent-remote-relay', 'exec', 'vitest', 'run', 'src/resources/input-image-store.test.ts', 'src/transport/image-input.test.ts', '--testTimeout=10000', '--hookTimeout=15000', '--maxWorkers=1'],
  'installer-windows': ['exec', 'node', '--test', '--test-timeout=180000', 'scripts/controller/install-windows.test.mjs'],
  'preview-browser': ['--filter', '@orchardworks/agent-remote-lab', 'exec', 'vitest', 'run', '--config=vitest.preview.config.ts', '--testTimeout=30000', '--hookTimeout=15000'],
  'codex-shared': ['--filter', '@orchardworks/agent-provider-codex', 'exec', 'vitest', 'run', 'src/shared-runtime.local.test.ts', '--testTimeout=30000', '--hookTimeout=15000', '--maxWorkers=1'],
  'host-package': ['exec', 'node', '--test', '--test-timeout=180000', 'scripts/agent-host-cli.test.mjs', 'scripts/agent-host-package.test.mjs'],
  'host-windows': ['--filter', '@orchardworks/agent-remote-controller', 'exec', 'vitest', 'run', 'src/windows.test.ts', 'src/connection-config.test.ts', '--testTimeout=15000', '--hookTimeout=15000'],
  'codex-transport': ['--filter', '@orchardworks/codex-daemon-client', 'exec', 'vitest', 'run', 'src/app-server-transport.test.ts', '--testTimeout=15000', '--hookTimeout=15000'],
  'windows-services': ['--filter', '@orchardworks/agent-remote-controller', 'exec', 'vitest', 'run', 'src/vscode-tunnel.test.ts', 'src/vscode-tunnel-supervisor.test.ts', 'src/windows-autostart.test.ts', 'src/windows-shared.test.ts', '--testTimeout=30000', '--hookTimeout=15000', '--maxWorkers=1'],
  'controller-updates': ['--filter', '@orchardworks/agent-remote-controller', 'exec', 'vitest', 'run', 'src/controller-package.test.ts', 'src/controller-update.test.ts', 'src/update-command.test.ts', 'src/controller-launcher.test.ts', 'src/controller-shutdown.test.ts', 'src/host.test.ts', ...(process.platform === 'win32' ? [] : ['src/cli-linux.test.ts', 'src/systemd.test.ts']), '--testTimeout=15000', '--hookTimeout=15000', '--maxWorkers=1'],
  'controller-updates-web': ['--filter', '@orchardworks/agent-remote-lab', 'exec', 'vitest', 'run', 'src/components/ControllerUpdates.test.tsx', '--testTimeout=10000', '--hookTimeout=15000'],
  'controller-updates-relay': ['--filter', '@orchardworks/agent-remote-cloudflare', 'exec', 'vitest', 'run', 'test/controller-updates.test.ts', '--testTimeout=30000', '--hookTimeout=30000', '--maxWorkers=1'],
  cloudflare: ['--filter', '@orchardworks/agent-remote-cloudflare', 'run', 'test', '--hookTimeout=30000'],
  copilot: ['--filter', '@orchardworks/agent-provider-copilot', 'run', 'test', '--hookTimeout=30000'],
  setup: ['exec', 'node', '--test', '--test-timeout=60000', 'scripts/dsh-debug.test.mjs', 'scripts/start.test.mjs', 'scripts/relay-local.test.mjs', 'scripts/controller/entrypoint.test.mjs', 'scripts/controller/create-host.test.mjs', 'scripts/controller/install.test.mjs'],
  unit: ['-r', 'run', 'test', '--hookTimeout=30000'],
  e2e: ['--filter', '@orchardworks/agent-remote-lab', 'exec', 'playwright', 'test', '--timeout=30000', '--global-timeout=480000', ...process.argv.slice(3)],
  conformance: ['--filter', '@orchardworks/agent-remote-lab', 'run', 'test:conformance'],
};
if (!(mode in commands)) throw new Error(`Unknown test suite: ${mode}`);
const child = spawn(...packageManager('pnpm', commands[mode]), { stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
function stop(signal) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill(signal));
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
