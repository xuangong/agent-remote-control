#!/usr/bin/env node
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { DSH_VERSION, PNPM_VERSION, parseOptions, requestJson, startProcess, waitFor } from './lib/dsh-debug-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `Agent Remote Control: guided DSH debugging

Usage: node scripts/dsh-debug.mjs [options]

  --dsh-repo PATH      Use a DSH ${DSH_VERSION} source checkout
  --build-dsh          Install missing source dependencies and run its official build
  --dsh PATH           Use an installed compatible DSH executable
  --home PATH          DSH home (default: .runtime/dsh-debug/home)
  --workspace PATH     Native session workspace (default: current directory)
  --dsh-port PORT      DSH Web port (default: 3081)
  --name NAME          Provider Host name (default: DSH Debug)
  --server-url URL     Relay origin (default: http://127.0.0.1:5910)
  --console-url URL    Workbench origin (default: http://127.0.0.1:6175)
  --state-dir PATH     Tool downloads and logs (default: .runtime/dsh-debug)
  --registry URL       npm registry (default: Tencent mirror)
  --yes               Accept the displayed defaults without prompting
  --help              Show this guide without changing files

Without a DSH path, use dsh on PATH or install the exact npm release locally.
If that release is unavailable, use --dsh-repo with the compatible source.
The script installs the Host plugin, creates a temporary pairing key, and
starts DSH. It reuses a running workbench or starts one on free local ports.
Ctrl+C stops only processes started by this script. Home and logs persist.
Pairing keys are never printed or saved. Model credentials stay with DSH.
`;

async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(directory, name);
    try { await access(path, constants.X_OK); return resolve(path); } catch {}
  }
}
async function freePort(port) {
  await new Promise((accept, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied. Choose another port; existing processes will not be stopped.`)));
    server.listen(port, '127.0.0.1', () => server.close(accept));
  });
}

async function configure(args) {
  let options = parseOptions(args, root, process.cwd());
  if (options.help) { console.log(help); return; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  if (!options.dsh && !options.dshRepo) options.dsh = await findExecutable('dsh');
  if (!options.yes) {
    if (!process.stdin.isTTY) throw new Error('Interactive setup needs a terminal. Use --yes with explicit options for non-interactive setup.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('\nInstall and start a DSH debugging Host. Press Enter to keep each default.');
      console.log('The default home is isolated from your normal DSH sessions and credentials.');
      if (!options.dsh && !options.dshRepo) {
        const source = (await prompt.question(`DSH ${DSH_VERSION} source directory [blank: install npm release]: `)).trim();
        if (source) args = [...args, '--dsh-repo', source];
      }
      for (const [flag, label, value] of [['--home', 'DSH home', options.home], ['--workspace', 'Workspace', options.workspace], ['--dsh-port', 'DSH Web port', options.dshPort]]) {
        const answer = (await prompt.question(`${label} [${value}]: `)).trim();
        if (answer) args = [...args, flag, answer];
      }
      const selected = parseOptions(args, root, process.cwd());
      if (selected.dshRepo && !selected.buildDsh) {
        const build = await prompt.question('Install dependencies and build this DSH checkout? Existing build outputs may change. [y/N]: ');
        if (/^y(es)?$/i.test(build.trim())) args = [...args, '--build-dsh'];
      }
      const proceed = await prompt.question('Install the plugin, generate a temporary key, and start debugging? [Y/n]: ');
      if (/^n(o)?$/i.test(proceed.trim())) return;
      options = parseOptions(args, root, process.cwd());
      if (!options.dsh && !options.dshRepo) options.dsh = await findExecutable('dsh');
    } finally { prompt.close(); }
  }
  if (!(await stat(options.workspace)).isDirectory()) throw new Error('Workspace must be an existing directory.');
  return options;
}

async function main() {
  const options = await configure(process.argv.slice(2));
  if (!options) return;
  await freePort(options.dshPort);
  await mkdir(join(options.stateDir, 'logs'), { recursive: true, mode: 0o700 });
  const logFile = join(options.stateDir, 'logs', `${new Date().toISOString().replaceAll(':', '-')}.log`);
  const controller = new AbortController();
  const children = [];
  const secrets = [];
  let env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, npm_config_registry: options.registry, npm_config_manage_package_manager_versions: 'false' };
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  function start(command, args, overrides = {}) {
    controller.signal.throwIfAborted();
    const child = startProcess(command, args, { cwd: root, env, logFile, secrets, ...overrides });
    children.push(child);
    return child;
  }
  async function run(command, args, overrides = {}) {
    const child = start(command, args, overrides);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void child.stop(); }, 600000);
    const abort = () => { void child.stop(); };
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await child.finished;
      controller.signal.throwIfAborted();
      if (timedOut) throw new Error('Command exceeded its 10 minute deadline.');
      if (result.code !== 0) throw result.error ?? new Error(`${command} failed (${result.code ?? result.signal}). See ${logFile}`);
    } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
  }
  async function pnpmFor(version) {
    const prefix = join(options.stateDir, 'tools', version);
    const executable = join(prefix, 'node_modules/.bin/pnpm');
    if (!await exists(executable)) {
      console.log(`Installing pnpm ${version} locally (${options.registry})...`);
      await run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', `pnpm@${version}`]);
    }
    return executable;
  }
  try {
    console.log(`\nWorkbench: ${options.consoleUrl}\nRelay: ${options.serverUrl}\nDSH home: ${options.home}\nWorkspace: ${options.workspace}\nLogs: ${logFile}`);
    const pnpm = await pnpmFor(PNPM_VERSION);
    env.PATH = `${dirname(pnpm)}${delimiter}${env.PATH}`;
    let dshCommand = options.dsh;
    let dshArgs = [];
    let sourceEnvironment = {};
    if (options.dshRepo) {
      const manifest = JSON.parse(await readFile(join(options.dshRepo, 'package.json'), 'utf8'));
      if (manifest.version !== DSH_VERSION) throw new Error(`DSH source version is ${manifest.version}; this plugin requires ${DSH_VERSION}.`);
      if (options.buildDsh) {
        const version = manifest.packageManager?.match(/^pnpm@([\d.]+)/)?.[1];
        if (!version) throw new Error('DSH source does not declare a pnpm version.');
        const sourcePnpm = await pnpmFor(version);
        console.log('Installing and building the selected DSH source checkout...');
        const sourceEnv = { ...env, PATH: `${dirname(sourcePnpm)}${delimiter}${env.PATH}` };
        if (!await exists(join(options.dshRepo, 'node_modules/.bin/tsx'))) await run(sourcePnpm, ['install', '--frozen-lockfile'], { cwd: options.dshRepo, env: sourceEnv });
        await run(sourcePnpm, ['run', 'build:official'], { cwd: options.dshRepo, env: sourceEnv });
      }
      const require = createRequire(join(options.dshRepo, 'package.json'));
      let tsx;
      try { tsx = require.resolve('tsx/esm'); }
      catch { throw new Error('DSH dependencies are missing. Run this script with --build-dsh to install and build the selected source checkout.'); }
      dshCommand = process.execPath;
      dshArgs = ['--import', tsx, join(options.dshRepo, 'apps/cli/src/bin.ts')];
      sourceEnvironment = { TSX_TSCONFIG_PATH: join(options.dshRepo, 'tsconfig.json') };
    }
    if (!await exists(join(root, 'node_modules/.modules.yaml'))) {
      console.log('Installing workbench dependencies...');
      await run(pnpm, ['install', '--frozen-lockfile']);
    }
    if (!await exists(join(root, 'packages/agent-remote-relay/dist/index.js'))) {
      console.log('Building the workbench packages...');
      await run(pnpm, ['build']);
    }
    if (!dshCommand) {
      const runtime = join(options.stateDir, 'runtime');
      console.log(`Installing DSH ${DSH_VERSION} locally. A different version will not be substituted.`);
      try {
        if (!await exists(join(runtime, 'package.json'))) await run(pnpm, ['--filter', 'agent-remote-lab', 'prepare:dsh-release', runtime]);
        await run('npm', ['install', '--prefix', runtime, '--no-audit', '--no-fund']);
      } catch (error) {
        throw new Error(`The pinned DSH release could not be installed. Use --dsh /path/to/dsh or --dsh-repo /path/to/deepseek-harness (${DSH_VERSION}).\n${error.message}`);
      }
      dshCommand = join(runtime, 'node_modules/.bin/dsh');
    }
    const versionOutput = [];
    await run(dshCommand, [...dshArgs, '--version'], { env: { ...env, ...sourceEnvironment }, output: (line) => versionOutput.push(line) });
    if (!versionOutput.join(' ').split(/\s+/).includes(DSH_VERSION)) throw new Error(`DSH version mismatch. Expected ${DSH_VERSION}; got ${versionOutput.join(' ')}.`);

    const relayUrl = new URL(options.serverUrl);
    const consoleUrl = new URL(options.consoleUrl);
    async function probe(origin) {
      try {
        const result = await requestJson(`${origin}/v1/remote/hosts`);
        if (!Array.isArray(result.hosts)) throw new Error(`${origin} is not an Agent Remote Control Host service.`);
        return result;
      } catch (error) {
        if (error.cause?.code === 'ECONNREFUSED') return;
        throw error;
      }
    }
    const relayReady = await probe(options.serverUrl);
    const consoleReady = await probe(options.consoleUrl);
    if (!relayReady || !consoleReady) {
      if (![relayUrl, consoleUrl].every((url) => url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Automatic startup requires local HTTP origins. Start the remote workbench first.');
      const relayPort = Number(relayUrl.port || 80);
      const webPort = Number(consoleUrl.port || 80);
      if (!relayReady) await freePort(relayPort);
      await freePort(webPort);
      console.log(relayReady ? 'Starting the workbench UI; reusing the running Relay...' : 'Starting the workbench and Relay...');
      const workbench = start(pnpm, ['dev', relayReady ? 'web' : 'local'], { env: { ...env, AGENT_REMOTE_PORT: String(relayPort), AGENT_REMOTE_WEB_PORT: String(webPort) } });
      await waitFor(async () => {
        if (!workbench.running) throw new Error('Workbench startup failed. Inspect the log above.');
        return await probe(options.serverUrl) && await probe(options.consoleUrl);
      }, { signal: controller.signal });
    } else console.log('Reusing the running workbench. It will remain running when this script exits.');

    console.log('Building and installing the Agent Remote Host plugin...');
    await run(pnpm, ['--filter', '@agent-remote-control/dsh', 'build:bundle']);
    const plugin = JSON.parse(await readFile(join(root, 'packages/agent-remote-dsh/package.json'), 'utf8'));
    const archive = join(root, `packages/agent-remote-dsh/dist/host-bundle/agent-remote-control-dsh-host-${plugin.version}.tgz`);
    await mkdir(options.home, { recursive: true, mode: 0o700 });
    const dshEnv = { ...env, ...sourceEnvironment, DSH_HOME: options.home };
    await run(dshCommand, [...dshArgs, 'plugin', '--profile', 'web', 'add', `file:${archive}`], { cwd: options.workspace, env: dshEnv });
    const invitation = await requestJson(`${options.serverUrl}/v1/remote/pairings`, { method: 'POST', body: '{}' });
    if (typeof invitation.key !== 'string' || !invitation.key.startsWith('arc_')) throw new Error('The workbench did not issue a valid pairing key.');
    secrets.push(invitation.key);
    console.log('Temporary pairing key generated. Starting DSH Web...');
    let registered = false;
    let dshWebUrl;
    const dsh = start(dshCommand, [...dshArgs, '--profile', 'web', '--host', '127.0.0.1', '--port', String(options.dshPort), '--no-open'], {
      cwd: options.workspace,
      env: { ...dshEnv, AGENT_REMOTE_SERVER_URL: options.serverUrl, AGENT_REMOTE_ACCESS_KEY: invitation.key, AGENT_REMOTE_INSTANCE_NAME: options.name },
      output: (line) => {
        if (line.includes('Agent Remote uplink registered.')) registered = true;
        const match = line.match(/^dsh web: (https?:\/\/\S+)/);
        if (match) dshWebUrl = match[1];
        console.log(line);
      },
    });
    const host = await waitFor(async () => {
      if (!dsh.running) throw new Error('DSH exited before registration. If source assets are missing, rerun with --build-dsh.');
      if (!registered || !dshWebUrl) return false;
      const result = await requestJson(`${options.serverUrl}/v1/remote/hosts`);
      return result.hosts.find((item) => item.online && item.name === options.name);
    }, { timeoutMs: 90000, signal: controller.signal });
    await requestJson(`${options.serverUrl}/v1/remote/hosts/${encodeURIComponent(host.id)}/workspaces`);
    const visible = await requestJson(`${options.consoleUrl}/v1/remote/hosts`);
    if (!visible.hosts?.some((item) => item.id === host.id && item.online)) throw new Error('The workbench is connected to a different Relay. Check --console-url and --server-url.');
    const webResponse = await fetch(dshWebUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    await webResponse.body?.cancel();
    if (![200, 302, 303].includes(webResponse.status)) throw new Error(`DSH Web is not ready (HTTP ${webResponse.status}). Inspect its startup diagnostics.`);
    await writeFile(join(options.stateDir, 'last-run.json'), JSON.stringify({ consoleUrl: options.consoleUrl, serverUrl: options.serverUrl, home: options.home, workspace: options.workspace, hostId: host.id, logFile }, null, 2) + '\n', { mode: 0o600 });
    console.log(`\nReady: DSH Host, workspace API, and DSH Web respond.\n\nWorkbench: ${options.consoleUrl}\nDSH Web: use the authenticated "dsh web:" URL printed above.\nProvider: DSH · ${options.name} · Online\n\nIn the workbench, select this Provider, choose a workspace, and click Open session.\nConfigure model credentials in DSH Web if this is a fresh home. No model request has been sent.\nKeep this terminal open. Press Ctrl+C to stop the processes started here.\nRerun the same command to keep the home and session history.\n`);
    controller.signal.throwIfAborted();
    await Promise.race([dsh.finished.then(() => { if (!controller.signal.aborted) throw new Error('DSH stopped. Inspect the log above.'); }), new Promise((accept) => controller.signal.addEventListener('abort', accept, { once: true }))]);
  } finally {
    console.log('\nStopping processes started by this script...');
    await Promise.all(children.map((child) => child.stop()));
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

main().catch((error) => {
  if (error.name === 'AbortError') { console.log('Debug environment stopped.'); return; }
  console.error(`\nSetup failed: ${error.message}\nUse --help for options. Existing services and DSH home files are preserved.`);
  process.exitCode = 1;
});
