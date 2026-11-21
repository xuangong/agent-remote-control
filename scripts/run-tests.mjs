import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { packageManager } from './lib/package-manager.mjs';
import { verifyNativeTestVersions } from './lib/native-test-versions.mjs';

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
const changedSinceModes = ['affected', 'affected-build', 'affected-typecheck'];
if (changedSinceModes.includes(mode) && !/^[0-9a-f]{7,40}$/.test(process.argv[3] ?? '')) throw new Error(`The ${mode} suite needs the commit to compare with.`);
if (mode === 'claude' && !process.env.AGENT_CLAUDE_TEST_EXECUTABLE) throw new Error('Set AGENT_CLAUDE_TEST_EXECUTABLE to Claude Code 2.1.247 or newer for native Claude tests.');
if (mode === 'native-opencode' && !isAbsolute(process.env.AGENT_OPENCODE_TEST_EXECUTABLE ?? '')) throw new Error('Set an absolute AGENT_OPENCODE_TEST_EXECUTABLE for the OpenCode native assumption checks.');
if (mode === 'codex-shared' && !process.env.AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE) throw new Error('Set AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE to the native Codex executable for shared-runtime tests.');
/**
 * Filters for the workspace packages changed since a commit, with their dependents. pnpm's own `...[commit]` filter
 * matches no package when the workspace is a nested git worktree, so the changed packages are found with git here.
 */
function affectedFilters(base) {
  const files = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' }).split('\n');
  const directories = new Set(files.map(file => /^packages\/[^/]+/.exec(file)?.[0]).filter(Boolean));
  return [...directories].filter(directory => existsSync(join(directory, 'package.json')))
    .flatMap(directory => ['--filter', `...${JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name}`]);
}
/**
 * The Cloudflare host proves only what the Workers runtime proves; the Relay's rules are tested in agent-relay-core and the
 * seams. Its tests therefore run when its own directory changed, not when a package below it did.
 */
function hostExclusions(base) {
  const files = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' }).split('\n');
  return files.some(file => file.startsWith('packages/agent-relay-cloudflare/')) ? [] : ['--filter', '!@orchardworks/agent-relay-cloudflare'];
}
const affected = changedSinceModes.includes(mode) ? affectedFilters(process.argv[3]) : [];
if (changedSinceModes.includes(mode) && !affected.length) {
  console.log('No workspace package changed, so nothing runs.');
  process.exit(0);
}
/** The package named by a directory name (`agent-client`) or a full package name, with the script that holds its unit tests. */
function workspacePackage(selector) {
  if (!selector) throw new Error('Name the package to test, for example: pnpm test:unit agent-client [vitest arguments].');
  for (const directory of readdirSync('packages')) {
    const manifest = join('packages', directory, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name, scripts = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
    if (selector === directory || selector === name) return { name, script: scripts['test:unit'] ? 'test:unit' : 'test' };
  }
  throw new Error(`No workspace package matches ${selector}.`);
}
const unitPackage = mode === 'unit-package' ? workspacePackage(process.argv[3]) : undefined;
const commands = {
  'live-cache-browser': ['--filter', '@orchardworks/agent-remote-lab', 'exec', 'playwright', 'test', '--config=e2e/session-live-cache.playwright.config.ts'],
  devbox: ['exec', 'node', '--test', '--test-timeout=18000', 'scripts/devbox/start.test.mjs', 'scripts/devbox/codex-profile.test.mjs', 'scripts/lib/build-provenance.test.mjs', 'scripts/controller/entrypoint.test.mjs'],
  'devbox-server': ['--filter', '@orchardworks/agent-relay-node', 'exec', 'vitest', 'run', 'src/devbox.test.ts', 'src/devbox-preview.test.ts', 'src/gateway-relay.test.ts', '--testTimeout=15000', '--hookTimeout=15000'],
  'local-env': ['exec', 'node', '--test', '--test-timeout=240000', '--test-concurrency=1', 'scripts/local/instance.test.mjs', 'scripts/local/environment.test.mjs', 'scripts/local/controller.test.mjs', 'scripts/local/session.test.mjs', 'scripts/local/runner.test.mjs', 'scripts/local/command.test.mjs'],
  'opencode-server-native': ['exec', 'node', '--test', '--test-timeout=60000', '--test-concurrency=1', 'scripts/opencode-managed-server-native.test.mjs'],
  'opencode-server': ['--filter', '@orchardworks/agent-remote-controller', 'exec', 'vitest', 'run', 'src/opencode-server.test.ts', 'src/opencode-server-supervisor.test.ts', 'src/provider-discovery.test.ts', 'src/registrations.test.ts', 'src/opencode-command.test.ts', 'src/opencode-executable.test.ts', 'src/connection-config.test.ts', 'src/host.test.ts', 'src/cli-bootstrap.test.ts', '--testTimeout=15000', '--hookTimeout=15000', '--maxWorkers=1'],
  'opencode-succession-adapter': ['exec', 'node', '--test', '--test-timeout=115000', '--test-concurrency=1', '--test-name-pattern=actual adapter', 'scripts/opencode-native-succession-evidence.test.mjs'],
  'opencode-succession-evidence': ['exec', 'node', '--test', '--test-timeout=115000', '--test-concurrency=1', 'scripts/opencode-native-succession-evidence.test.mjs'],
  'opencode-native': ['exec', 'node', '--test', '--test-timeout=150000', '--test-concurrency=1', 'scripts/opencode-native.test.mjs', 'scripts/opencode-native-boundaries.test.mjs', 'scripts/opencode-native-steer.test.mjs', 'scripts/opencode-native-callbacks.test.mjs'],
  opencode: ['--filter', '@orchardworks/agent-provider-opencode', 'exec', 'vitest', 'run', '--testTimeout=10000', '--hookTimeout=15000', '--maxWorkers=1'],
  'image-input': ['--filter', '@orchardworks/agent-session-runtime', 'exec', 'vitest', 'run', 'src/resources/input-image-store.test.ts', 'src/transport/image-input.test.ts', '--testTimeout=10000', '--hookTimeout=15000', '--maxWorkers=1'],
  'installer-windows': ['exec', 'node', '--test', '--test-timeout=180000', 'scripts/controller/install-windows.test.mjs'],
  'preview-browser': ['--filter', '@orchardworks/agent-remote-lab', 'exec', 'vitest', 'run', '--config=vitest.preview.config.ts', '--testTimeout=30000', '--hookTimeout=15000'],
  'codex-shared': ['--filter', '@orchardworks/agent-provider-codex', 'exec', 'vitest', 'run', 'src/shared-runtime.local.test.ts', '--testTimeout=30000', '--hookTimeout=15000', '--maxWorkers=1'],
  'host-package': ['exec', 'node', '--test', '--test-timeout=180000', 'scripts/agent-host-cli.test.mjs', 'scripts/agent-host-package.test.mjs'],
  'host-windows': ['--filter', '@orchardworks/agent-remote-controller', 'exec', 'vitest', 'run', 'src/windows.test.ts', 'src/connection-config.test.ts', '--testTimeout=15000', '--hookTimeout=15000'],
  'codex-transport': ['--filter', '@orchardworks/codex-daemon-client', 'exec', 'vitest', 'run', 'src/app-server-transport.test.ts', '--testTimeout=15000', '--hookTimeout=15000'],
  'windows-services': ['--filter', '@orchardworks/agent-remote-controller', 'exec', 'vitest', 'run', 'src/vscode-tunnel.test.ts', 'src/vscode-tunnel-supervisor.test.ts', 'src/windows-autostart.test.ts', 'src/windows-shared.test.ts', '--testTimeout=30000', '--hookTimeout=15000', '--maxWorkers=1'],
  'controller-updates': ['--filter', '@orchardworks/agent-remote-controller', 'exec', 'vitest', 'run', 'src/controller-package.test.ts', 'src/controller-update.test.ts', 'src/update-command.test.ts', 'src/controller-launcher.test.ts', 'src/controller-shutdown.test.ts', 'src/host.test.ts', ...(process.platform === 'win32' ? [] : ['src/cli-linux.test.ts', 'src/systemd.test.ts']), '--testTimeout=15000', '--hookTimeout=15000', '--maxWorkers=1'],
  'controller-updates-web': ['--filter', '@orchardworks/agent-remote-lab', 'exec', 'vitest', 'run', 'src/components/ControllerUpdates.test.tsx', '--testTimeout=10000', '--hookTimeout=15000'],
  'controller-updates-relay': ['--filter', '@orchardworks/agent-relay-cloudflare', 'exec', 'vitest', 'run', 'test/controller-updates.workers.test.ts', '--testTimeout=30000', '--hookTimeout=30000', '--maxWorkers=1'],
  cloudflare: ['--filter', '@orchardworks/agent-relay-cloudflare', 'run', 'test', '--hookTimeout=30000'],
  workers: ['--filter', '@orchardworks/agent-relay-cloudflare', 'run', 'test:workers', '--hookTimeout=30000'],
  claude: ['--filter', '@orchardworks/agent-provider-claude', 'exec', 'vitest', 'run', '--testTimeout=10000', '--hookTimeout=15000', '--maxWorkers=1'],
  'claude-succession-evidence': ['--filter', '@orchardworks/agent-provider-claude', 'exec', 'vitest', 'run', 'src/native-succession-evidence.local.test.ts', '--testTimeout=30000', '--hookTimeout=10000', '--maxWorkers=1'],
  copilot: ['--filter', '@orchardworks/agent-provider-copilot', 'run', 'test', '--hookTimeout=30000'],
  setup: ['exec', 'node', '--test', '--test-timeout=60000', 'scripts/native-test-versions.test.mjs', 'scripts/dsh-debug.test.mjs', 'scripts/start.test.mjs', 'scripts/relay-local.test.mjs', 'scripts/prepare-relay-docker-lock.test.mjs', 'scripts/controller/entrypoint.test.mjs', 'scripts/controller/create-host.test.mjs', 'scripts/controller/install.test.mjs', 'scripts/local/instance.test.mjs', 'scripts/local/environment.test.mjs', 'scripts/local/controller.test.mjs', 'scripts/local/session.test.mjs', 'scripts/local/runner.test.mjs', 'scripts/lib/arch-check.test.mjs', 'scripts/lib/test-inventory.test.mjs', 'scripts/lib/fixtures-check.test.mjs', 'scripts/lib/slow-test-reporter.test.mjs', 'scripts/lib/slow-test-allowlist.test.mjs'],
  // Each package's Vitest already uses every core; running packages one at a time avoids load-induced timeouts.
  unit: ['-r', '--workspace-concurrency=1', 'run', 'test'],
  // The packages changed since a commit and the packages that depend on them; the workspace root runs everything.
  affected: ['-r', '--workspace-concurrency=1', ...affected, ...(mode === 'affected' ? hostExclusions(process.argv[3]) : []), 'run', 'test'],
  'affected-build': ['-r', ...affected, 'run', 'build'],
  'affected-typecheck': ['-r', ...affected, 'run', 'typecheck'],
  // One package's unit suite with its own timeouts and exclusions; extra arguments go to Vitest (a file, --changed, -t).
  'unit-package': ['--filter', unitPackage?.name ?? '', 'run', unitPackage?.script ?? 'test', ...process.argv.slice(4)],
  // Native CLI tests depend on this machine's installed and signed-in agents, so the unit suite excludes them.
  local: ['-r', '--workspace-concurrency=1', 'exec', 'vitest', 'run', '--passWithNoTests', '--testTimeout=60000', '--hookTimeout=30000', '--maxWorkers=1', 'local.test'],
  // The page against a real CLI runtime (agent-e2e/native), by hand or nightly; each spec is skipped unless its runtime is selected.
  'native-browser': ['--filter', '@orchardworks/agent-e2e', 'exec', 'playwright', 'test', '--config=playwright.native.config.ts', '--timeout=30000', '--global-timeout=1400000', ...process.argv.slice(3)],
  // The component tier: fixture pages of the Workbench on builder states, with no Relay. It holds the phone and WebKit projects of the
  // specs that left the older Relay-backed tiers, about 1,450 runs on one worker.
  components: ['--filter', '@orchardworks/agent-remote-lab', 'exec', 'playwright', 'test', '--config=playwright.components.config.ts', '--timeout=30000', '--global-timeout=1500000', ...process.argv.slice(3)],
  conformance: ['--filter', '@orchardworks/agent-relay-node', 'run', 'test:conformance'],
  // The native assumption checks of each CLI, by hand or nightly: the declaration and the recordings against the installed CLI (gap 6).
  'native-codex': ['--filter', '@orchardworks/agent-provider-codex', 'run', 'test:native'],
  'native-claude': ['--filter', '@orchardworks/agent-provider-claude', 'run', 'test:native'],
  'native-copilot': ['--filter', '@orchardworks/agent-provider-copilot', 'run', 'test:native'],
  'native-opencode': ['--filter', '@orchardworks/agent-provider-opencode', 'run', 'test:native'],
  // The provider conformance kit for every journal-capable adapter, on mock data: recordings, declared behaviour and faults through the port.
  providers: ['--filter', '@orchardworks/agent-remote-controller', 'exec', 'vitest', 'run', 'src/provider-conformance.test.ts', '--testTimeout=10000', '--hookTimeout=10000'],
  'e2e-flows': ['--filter', '@orchardworks/agent-e2e', 'run', 'test:e2e'],
};
if (!(mode in commands)) throw new Error(`Unknown test suite: ${mode}`);
await verifyNativeTestVersions(mode);
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
// The Playwright runs use one worker over several projects (desktop, phone, Safari); each has a global deadline below its outer one.
const outerDeadlineMs = mode === 'native-browser' ? 1_500_000 : mode === 'components' ? 1_600_000 : mode === 'e2e-flows' ? 240_000 : mode === 'live-cache-browser' ? 150_000 : mode === 'devbox' ? 30_000 : mode === 'devbox-server' ? 80_000 : mode === 'opencode-server-native' ? 90_000 : successionEvidence || opencodeSuccessionEvidence ? 120_000 : 540_000;
const deadline = setTimeout(() => {
  process.stderr.write(`${mode} suite exceeded its ${outerDeadlineMs / 1000} second deadline.\n`);
  stop('SIGKILL');
}, outerDeadlineMs);
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
child.once('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
child.once('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
