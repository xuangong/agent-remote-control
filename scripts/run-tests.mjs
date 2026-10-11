import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { packageManager } from './lib/package-manager.mjs';

const mode = process.argv[2] ?? 'unit';
const successionEvidence = mode === 'claude-succession-evidence';
const opencodeSuccessionEvidence = mode === 'opencode-succession-evidence' || mode === 'opencode-succession-adapter';
if (mode === 'opencode-server-native' && !isAbsolute(process.env.AGENT_OPENCODE_TEST_EXECUTABLE ?? ''))
  throw new Error('Set an absolute AGENT_OPENCODE_TEST_EXECUTABLE for the isolated OpenCode managed-server smoke.');
if (opencodeSuccessionEvidence) {
  if (!isAbsolute(process.env.AGENT_OPENCODE_TEST_EXECUTABLE ?? '')) throw new Error('Set an absolute AGENT_OPENCODE_TEST_EXECUTABLE for OpenCode 2.0.25 or newer.');
  if (process.env.AGENT_OPENCODE_SUCCESSION_EVIDENCE_OUTPUT !== undefined && !isAbsolute(process.env.AGENT_OPENCODE_SUCCESSION_EVIDENCE_OUTPUT)) throw new Error('Set AGENT_OPENCODE_SUCCESSION_EVIDENCE_OUTPUT to a new absolute JSON output path, or omit it.');
}
if (successionEvidence) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(process.versions.node.split('.')[0]) !== 26) {
    throw new Error('The Claude succession evidence experiment requires macOS arm64 and Node 26.');
  }
  if (!isAbsolute(process.env.AGENT_CLAUDE_TEST_EXECUTABLE ?? '')) throw new Error('Set an absolute AGENT_CLAUDE_TEST_EXECUTABLE for the installed SDK-bundled Claude 2.1.247.');
  if (!isAbsolute(process.env.AGENT_CLAUDE_SUCCESSION_EVIDENCE_OUTPUT ?? '')) throw new Error('Set AGENT_CLAUDE_SUCCESSION_EVIDENCE_OUTPUT to a new absolute JSON output path.');
}
if (mode === 'claude' && !process.env.AGENT_CLAUDE_TEST_EXECUTABLE) throw new Error('Set AGENT_CLAUDE_TEST_EXECUTABLE to Claude Code 2.1.247 or newer for native Claude tests.');
if (mode === 'codex-shared' && !process.env.AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE) throw new Error('Set AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE to the native Codex executable for shared-runtime tests.');
const commands = {
  'opencode-server-native': ['exec', 'node', '--test', '--test-timeout=60000', '--test-concurrency=1', 'scripts/opencode-managed-server-native.test.mjs'],
  'opencode-server': ['--filter', '@orchardworks/agent-remote-controller', 'exec', 'vitest', 'run', 'src/opencode-server.test.ts', 'src/opencode-server-supervisor.test.ts', 'src/provider-discovery.test.ts', 'src/registrations.test.ts', 'src/opencode-command.test.ts', 'src/opencode-executable.test.ts', 'src/connection-config.test.ts', 'src/host.test.ts', 'src/cli-bootstrap.test.ts', '--testTimeout=15000', '--hookTimeout=15000', '--maxWorkers=1'],
  'opencode-succession-adapter': ['exec', 'node', '--test', '--test-timeout=115000', '--test-concurrency=1', '--test-name-pattern=actual adapter', 'scripts/opencode-native-succession-evidence.test.mjs'],
  'opencode-succession-evidence': ['exec', 'node', '--test', '--test-timeout=115000', '--test-concurrency=1', 'scripts/opencode-native-succession-evidence.test.mjs'],
  'opencode-native': ['exec', 'node', '--test', '--test-timeout=150000', '--test-concurrency=1', 'scripts/opencode-native.test.mjs', 'scripts/opencode-native-boundaries.test.mjs', 'scripts/opencode-native-steer.test.mjs', 'scripts/opencode-native-callbacks.test.mjs'],
  opencode: ['--filter', '@orchardworks/agent-provider-opencode', 'exec', 'vitest', 'run', '--testTimeout=10000', '--hookTimeout=15000', '--maxWorkers=1'],
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
  claude: ['--filter', '@orchardworks/agent-provider-claude', 'exec', 'vitest', 'run', '--testTimeout=10000', '--hookTimeout=15000', '--maxWorkers=1'],
  'claude-succession-evidence': ['--filter', '@orchardworks/agent-provider-claude', 'exec', 'vitest', 'run', 'src/native-succession-evidence.local.test.ts', '--testTimeout=30000', '--hookTimeout=10000', '--maxWorkers=1'],
  copilot: ['--filter', '@orchardworks/agent-provider-copilot', 'run', 'test', '--hookTimeout=30000'],
  setup: ['exec', 'node', '--test', '--test-timeout=60000', 'scripts/dsh-debug.test.mjs', 'scripts/start.test.mjs', 'scripts/relay-local.test.mjs', 'scripts/controller/entrypoint.test.mjs', 'scripts/controller/create-host.test.mjs', 'scripts/controller/install.test.mjs'],
  unit: ['-r', 'run', 'test'],
  e2e: ['--filter', '@orchardworks/agent-remote-lab', 'exec', 'playwright', 'test', '--timeout=30000', '--global-timeout=480000', ...process.argv.slice(3)],
  conformance: ['--filter', '@orchardworks/agent-remote-lab', 'run', 'test:conformance'],
};
if (!(mode in commands)) throw new Error(`Unknown test suite: ${mode}`);
const child = spawn(...packageManager('pnpm', commands[mode]), { stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32',
  env: { ...process.env, AGENT_CLAUDE_SUCCESSION_EVIDENCE: successionEvidence ? '1' : undefined,
    AGENT_OPENCODE_SUCCESSION_EVIDENCE: mode === 'opencode-succession-evidence' ? '1' : undefined,
    AGENT_OPENCODE_ACTUAL_SUCCESSION: mode === 'opencode-succession-adapter' ? '1' : undefined } });
function stop(signal) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill(signal));
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
const outerDeadlineMs = mode === 'opencode-server-native' ? 90_000 : successionEvidence || opencodeSuccessionEvidence ? 120_000 : 540_000;
const deadline = setTimeout(() => {
  process.stderr.write(`${mode} suite exceeded its ${outerDeadlineMs / 1000} second deadline.\n`);
  stop('SIGKILL');
}, outerDeadlineMs);
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
child.once('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
child.once('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
