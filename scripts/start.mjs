#!/usr/bin/env node
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controllerOptions, executablePath, assertFreePort } from './lib/controller-options.mjs';
import { PNPM_VERSION, requestJson, startProcess, waitFor } from './lib/dsh-debug-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `Start Remote Controller with Codex, Claude, and DSH

Usage: pnpm start [options]
       node scripts/start.mjs [options]

Builds Agent Host and Web, starts a local Broker and the built Web UI, pairs
Codex + Claude through Agent Host, and starts DSH with its native Host plugin.
Prints the Remote Controller URL after all three providers are ready.

  --config PATH       Read a JSON configuration; CLI options override it
  --codex PATH        Codex executable (default: AGENT_HOST_CODEX or codex on PATH)
  --claude PATH       Claude executable (default: AGENT_HOST_CLAUDE or claude on PATH)
  --dsh PATH          Installed DSH executable; otherwise discover/install via DSH setup
  --dsh-repo PATH     Use a compatible DSH source checkout instead
  --build-dsh         Build that source checkout with its official build command
  --workspace PATH    Native session workspace (default: current directory)
  --codex-home PATH   Optional native Codex profile
  --claude-home PATH  Optional native Claude profile
  --dsh-home PATH     DSH home (default: STATE_DIR/dsh/home)
  --state-dir PATH    Persistent homes, logs, and startup lock (default: .runtime/controller)
  --web-port PORT     Remote Controller Web port (default: 6175)
  --relay-port PORT   Pairing Broker port (default: 5910)
  --dsh-port PORT     DSH Web port (default: 3081)
  --name NAME         Host label prefix (default: Remote Controller)
  --registry URL      Installation registry (default: Tencent mirror)
  --help, -h          Show help without changing files

Requires Node 22+ and pnpm ${PNPM_VERSION}. Missing repository dependencies
are installed; every start rebuilds the repository and DSH Host plugin.
Native credentials remain in native profiles. No model prompt is submitted.
Keep this terminal open. Ctrl+C stops only this launch's processes, including
its Host-owned sessions. Homes and history persist. Existing services are not reused.
`;

async function exists(path) { try { await stat(path); return true; } catch { return false; } }

async function main() {
  const options = await controllerOptions(process.argv.slice(2), root, process.cwd());
  if (options.help) { console.log(help); return; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const lock = join(options.stateDir, 'run.lock');
  if (await exists(lock)) throw new Error(`State directory already in use: ${lock}. Check its owner.json before removing a stale lock.`);
  for (const port of [options.webPort, options.relayPort, options.dshPort]) await assertFreePort(port);
  if (!(await stat(options.workspace)).isDirectory()) throw new Error('Workspace must be an existing directory.');
  let env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    npm_config_registry: options.registry, npm_config_manage_package_manager_versions: 'false' };
  const pnpm = await executablePath('pnpm', env);
  options.codex = await executablePath(options.codex, env);
  options.claude = await executablePath(options.claude, env);
  if (options.dsh) options.dsh = await executablePath(options.dsh, env);
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`State directory already in use: ${lock}.`); throw error; }
  const controller = new AbortController();
  const children = [];
  const secrets = [];
  const logFile = join(options.stateDir, `startup-${new Date().toISOString().replaceAll(':', '-')}.log`);
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  function start(label, command, args, overrides = {}) {
    controller.signal.throwIfAborted();
    const child = startProcess(command, args, { cwd: root, env, logFile, secrets,
      output: (line) => { if (line) console.log(`[${label}] ${line}`); }, ...overrides });
    children.push(child);
    return child;
  }
  async function run(label, command, args, timeoutMs = 600000) {
    const lines = [];
    const child = start(label, command, args, { output: (line) => lines.push(line) });
    const timeout = setTimeout(() => controller.abort(new Error(`${label} exceeded its ${timeoutMs / 1000} second deadline.`)), timeoutMs);
    const abort = () => { void child.stop(); };
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await child.finished;
      controller.signal.throwIfAborted();
      if (result.code !== 0) throw new Error(`${label} failed (${result.code ?? result.signal}). See ${logFile}`);
      return lines.join('\n').trim();
    } finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', abort); }
  }
  function service(label, command, args, overrides = {}) {
    const child = start(label, command, args, overrides);
    void child.finished.then(() => { if (!controller.signal.aborted) controller.abort(new Error(`${label} exited. See ${logFile}`)); });
    return child;
  }
  async function ready(check, timeoutMs = 90000) {
    return waitFor(check, { timeoutMs, intervalMs: 300, signal: controller.signal });
  }
  async function reachable(url) {
    try { return await requestJson(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) }); }
    catch (error) { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; }
  }
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, root }), { mode: 0o600 });
    await rm(join(options.stateDir, 'ready.json'), { force: true });
    console.log(`Logs: ${logFile}`);
    const version = await run('pnpm version', pnpm, ['--version'], 10000);
    if (version !== PNPM_VERSION) throw new Error(`Use pnpm ${PNPM_VERSION}; found ${version}.`);
    // The Host owns native version policy; fail before a build when a binary cannot execute.
    for (const provider of ['codex', 'claude']) console.log(`${provider}: ${await run(`${provider} version`, options[provider], ['--version'], 10000)}`);
    if (!await exists(join(root, 'node_modules/.modules.yaml'))) {
      console.log('Installing repository dependencies...');
      await run('Dependency installation', pnpm, ['install', '--frozen-lockfile']);
    }
    console.log('Building Agent Host, providers, Relay, and Web...');
    await run('Repository build', pnpm, ['build']);
    await run('Compatibility check', pnpm, ['compatibility:check']);
    env = { ...env, AGENT_REMOTE_PORT: String(options.relayPort), AGENT_REMOTE_BIND: '127.0.0.1',
      AGENT_REMOTE_ORIGIN: options.consoleUrl, AGENT_REMOTE_WORKSPACE: options.workspace,
      VITE_AGENT_REMOTE_RELAY_TARGET: options.serverUrl };
    console.log('Starting Broker and built Web UI...');
    service('Broker', pnpm, ['--filter', 'agent-remote-lab', 'exec', 'tsx', 'src/server/local.ts']);
    service('Web', pnpm, ['--filter', 'agent-remote-lab', 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(options.webPort), '--strictPort']);
    await ready(async () => {
      const relay = await reachable(`${options.serverUrl}/v1/remote/hosts`);
      if (!relay) return false;
      const web = await reachable(`${options.consoleUrl}/v1/remote/hosts`);
      return relay && web && Array.isArray(relay.hosts) && Array.isArray(web.hosts);
    });
    const invitation = await requestJson(`${options.serverUrl}/v1/remote/pairings`, {
      method: 'POST', body: '{}', headers: { origin: options.consoleUrl }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    });
    if (typeof invitation.key !== 'string' || !invitation.key.startsWith('arc_')) throw new Error('Broker did not return a temporary pairing key.');
    secrets.push(invitation.key);
    console.log('Starting Agent Host with Codex and Claude...');
    const nativeName = `${options.name} · Codex + Claude`;
    service('Agent Host', process.execPath, [join(root, 'packages/agent-host/dist/cli.js'), 'foreground'], {
      env: { ...env, AGENT_HOST_SERVER: options.serverUrl, AGENT_HOST_REMOTE_KEY: invitation.key,
        AGENT_HOST_PROVIDERS: 'codex,claude', AGENT_HOST_CODEX: options.codex, AGENT_HOST_CLAUDE: options.claude,
        AGENT_HOST_NAME: nativeName, AGENT_HOST_WORKSPACE: options.workspace, AGENT_HOST_STATE_DIR: join(options.stateDir, 'agent-host'),
        ...(options.codexHome ? { AGENT_REMOTE_CODEX_HOME: options.codexHome } : {}),
        ...(options.claudeHome ? { AGENT_HOST_CLAUDE_HOME: options.claudeHome } : {}),
      }, stopTimeoutMs: 10000,
    });
    await ready(async () => (await reachable(`${options.serverUrl}/v1/remote/hosts`))?.hosts.find((host) => host.online && host.name === nativeName));
    console.log('Building and installing the DSH Host plugin, then starting DSH...');
    const dshState = join(options.stateDir, 'dsh');
    await rm(join(dshState, 'last-run.json'), { force: true });
    const dshName = `${options.name} · DSH`;
    const dshArgs = ['--yes', '--state-dir', dshState, '--home', options.dshHome, '--workspace', options.workspace,
      '--server-url', options.serverUrl, '--console-url', options.consoleUrl, '--dsh-port', String(options.dshPort),
      '--name', dshName, '--registry', options.registry];
    if (options.dsh) dshArgs.push('--dsh', options.dsh);
    if (options.dshRepo) dshArgs.push('--dsh-repo', options.dshRepo);
    if (options.buildDsh) dshArgs.push('--build-dsh');
    service('DSH setup', process.execPath, [join(root, 'scripts/dsh-debug.mjs'), ...dshArgs], {
      stopTimeoutMs: 15000,
      output: (line) => { if (line.startsWith('dsh web:')) console.log(`[DSH] ${line}`); },
    });
    await ready(async () => exists(join(dshState, 'last-run.json')), 1800000);
    const hosts = await requestJson(`${options.consoleUrl}/v1/remote/hosts`);
    const selected = [];
    for (const [name, providerIds] of [[nativeName, ['codex', 'claude']], [dshName, ['dsh']]]) {
      const host = hosts.hosts.find((entry) => entry.online && entry.name === name);
      if (!host || !providerIds.every((id) => host.providers?.some((provider) => provider.providerId === id))) throw new Error(`Providers are not online: ${name}.`);
      for (const providerId of providerIds) {
        for (const action of ['workspaces', 'catalog']) {
          await requestJson(`${options.consoleUrl}/v1/remote/hosts/${encodeURIComponent(host.id)}/${action}?providerId=${providerId}${action === 'catalog' ? '&limit=1' : ''}`,
            { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        }
        console.log(`Ready: ${providerId} · ${host.name}`);
      }
      selected.push({ hostId: host.id, providers: providerIds });
    }
    controller.signal.throwIfAborted();
    await writeFile(join(options.stateDir, 'ready.json'), JSON.stringify({ pid: process.pid, root, consoleUrl: options.consoleUrl,
      serverUrl: options.serverUrl, dshUrl: `http://127.0.0.1:${options.dshPort}`, hosts: selected, logFile }, null, 2) + '\n', { mode: 0o600 });
    console.log(`\nAll three providers are online. Keep this terminal open; Ctrl+C stops this environment.\nRemote Controller: ${options.consoleUrl}`);
    await new Promise((accept) => {
      if (controller.signal.aborted) accept();
      else controller.signal.addEventListener('abort', accept, { once: true });
    });
    controller.signal.throwIfAborted();
  } finally {
    controller.abort();
    console.log('Stopping processes started by this launcher...');
    for (const child of children.toReversed()) await child.stop();
    await rm(join(options.stateDir, 'ready.json'), { force: true });
    await rm(lock, { recursive: true, force: true });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

main().catch((error) => {
  if (error.name === 'AbortError') { console.log('Remote Controller stopped.'); return; }
  console.error(`Startup failed: ${error.message}\nUse --help for options.`);
  process.exitCode = 1;
});
