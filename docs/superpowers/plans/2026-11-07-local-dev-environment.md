# Native Local Development Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm local` runs one checkout's complete product on macOS — signed-in website and Relay plus a paired development Controller — per worktree, and a `prepare-arc-local` skill teaches agents to prepare, verify and drive it.

**Architecture:** A detached runner (`scripts/local/runner.mjs`) serves the existing Devbox server bundle (`dist/devbox/server.mjs`, local identity and pairing already implemented) on a per-instance loopback port and starts `packages/agent-host/dist/cli.js foreground` from the same checkout with an explicit environment. `scripts/local/command.mjs` builds, starts, stops and inspects instances under `~/.agent-remote-control-dev/instances/<checkout>-<hash>/`. The skill lives in `.agents/skills/prepare-arc-local/` with `.claude/skills` linking to it.

**Tech Stack:** Node 22+ ESM scripts, `node:test`, the Devbox server from `@orchardworks/agent-remote-lab`, the Controller CLI from `@orchardworks/agent-remote-controller`, Playwright 1.62 (`@playwright/test` in the Lab package).

**Spec:** `docs/superpowers/specs/2026-11-07-local-dev-environment-design.md`

**Working directory:** every path and command below is relative to the worktree `/Volumes/Projects/agent-remote-control/.worktrees/local-dev-env` (branch `feat/local-dev-env`). Do not push.

---

## File map

| File | Responsibility |
| --- | --- |
| Create `scripts/local/instance.mjs` | Instance root, naming, file layout, JSON records, port choice, process checks, operation lock |
| Create `scripts/local/environment.mjs` | Explicit environment for the development Controller |
| Create `scripts/local/runner.mjs` | Detached runner: Devbox server, first pairing, Controller child, shutdown |
| Create `scripts/local/session.mjs` | Signed-in local user session, user API calls, headless screenshot |
| Create `scripts/local/command.mjs` | `pnpm local` commands: up, down, status, logs, list, remove, controller, api, screenshot |
| Create `scripts/local/*.test.mjs` | Unit tests per module and one integration test for the command |
| Modify `package.json` | `local` and `test:local-env` scripts |
| Modify `scripts/run-tests.mjs` | `local-env` suite and its deadline; launcher tests in `setup` |
| Create `docs/local-development.md` | Human guide owning the mechanism |
| Modify `README.md`, `AGENTS.md` | Entry points |
| Create `.agents/skills/prepare-arc-local/**`, `.claude/skills` | Skill and its Claude Code link |
| Modify the spec | Record `runtime.json`, the occupied-port rule, shared-process controls |

---

### Task 0: Prepare the worktree

**Files:** none

- [ ] **Step 1: Install dependencies and build the workspace**

The fresh worktree has no `node_modules`. Use Node 24 from nvm (Homebrew Node 26 breaks some jsdom tests in this repo):

```bash
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"
pnpm install --frozen-lockfile
pnpm -r run build
```

Expected: both commands exit 0; `packages/agent-host/dist/cli.js` exists. `pnpm -r run build` (not `pnpm build`) avoids `compatibility:update` rewriting tracked files.

---

### Task 1: Align the spec with implementation details

**Files:**
- Modify: `docs/superpowers/specs/2026-11-07-local-dev-environment-design.md`

- [ ] **Step 1: Split the instance record from the run record**

Replace the layout block's first line

```
  instance.json   source path, commit, dirty flag, port, origin, runner and Controller PIDs
```

with

```
  instance.json   checkout path, port and origin (written once)
  runtime.json    current run: build commit and dirty flag, runner and Controller PIDs (written by the runner)
```

and in the paragraph below it replace "`instance.json` holds no credentials;" with "`instance.json` and `runtime.json` hold no credentials;".

- [ ] **Step 2: State the occupied-port rule and the shared-process controls**

In "Lifecycle" step 2, after "a recorded port is reused and a change is refused." add: "If another process holds the recorded port, `up` stops with an error instead of choosing a new one."

In "Testing", replace "port allocation recorded and reused, changed origin refused;" with "port allocation recorded and reused, an occupied recorded port refused;".

In "Hard rules in `SKILL.md`", insert after rule 2 a new rule and renumber the rest:

```
3. In the instance website, do not use Controller update, Codex daemon restart,
   OpenCode server or VS Code tunnel controls; they act on processes shared with
   the user's Controller.
```

In the "Command" table, change the `controller <args>` row's behaviour to: "Run the development Controller CLI with this instance's state directory; only `status`, `diagnostics`, `window`, `session` and `environment` are allowed."

The spec's Lifecycle build step and stale-PID sentence (which now names `runtime.json`) are aligned with these decisions as well.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-11-07-local-dev-environment-design.md
git commit -m "docs(spec): record the run file, port rule and shared-process controls

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Instance records

**Files:**
- Create: `scripts/local/instance.mjs`
- Test: `scripts/local/instance.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `scripts/local/instance.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { findInstance, instanceName, listInstances, localRoot, portAvailable, prepareInstance, runState, withLock, writeJson } from './instance.mjs';

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'arc-local-instance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  return child.pid;
}

/** A live process whose command line ends with the given marker arguments. */
async function idleProcess(t, ...marker) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...marker], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await once(child, 'spawn');
  return child;
}

test('names an instance stably per checkout path', () => {
  assert.equal(instanceName('/work/.worktrees/feature'), instanceName('/work/.worktrees/feature'));
  assert.notEqual(instanceName('/work/.worktrees/feature'), instanceName('/other/feature'));
  assert.match(instanceName('/work/.worktrees/feature'), /^feature-[0-9a-f]{8}$/);
  assert.match(instanceName('/work/odd name!'), /^odd-name--[0-9a-f]{8}$/);
});

test('resolves a relative root so every command addresses the same instances', () => {
  assert.equal(localRoot({ ARC_LOCAL_ROOT: 'relative-root' }), resolve('relative-root'));
});

test('records a port once and reuses it', async t => {
  const environment = { ARC_LOCAL_ROOT: await temporaryRoot(t) };
  const first = await prepareInstance('/src/one', environment);
  const second = await prepareInstance('/src/one', environment);
  assert.equal(second.record.port, first.record.port);
  assert.equal(first.record.origin, `http://localhost:${first.record.port}`);
  assert.equal(first.directory, join(environment.ARC_LOCAL_ROOT, 'instances', instanceName('/src/one')));
  for (const directory of [first.relay, first.controller, first.workspace, first.logs]) assert.ok((await stat(directory)).isDirectory());
  assert.equal((await stat(first.recordFile)).mode & 0o777, 0o600);
  assert.deepEqual((await findInstance('/src/one', environment)).record, first.record);
  assert.equal(await findInstance('/src/two', environment), undefined);
});

test('agrees on one port when several commands start the same checkout together', async t => {
  for (let round = 0; round < 20; round++) {
    const environment = { ARC_LOCAL_ROOT: await temporaryRoot(t) };
    const instances = await Promise.all(Array.from({ length: 4 }, () => prepareInstance('/src/one', environment)));
    assert.equal(new Set(instances.map(instance => instance.record.port)).size, 1);
    assert.deepEqual((await findInstance('/src/one', environment)).record, instances[0].record);
    assert.deepEqual((await readdir(instances[0].directory)).filter(name => name.endsWith('.tmp')), []);
  }
});

test('refuses an instance directory recorded for another checkout', async t => {
  const environment = { ARC_LOCAL_ROOT: await temporaryRoot(t) };
  const instance = await prepareInstance('/src/one', environment);
  await writeFile(instance.recordFile, JSON.stringify({ ...instance.record, source: '/src/elsewhere' }));
  await assert.rejects(prepareInstance('/src/one', environment), /belongs to \/src\/elsewhere/);
  assert.equal(await findInstance('/src/one', environment), undefined);
});

test('names the file when an instance record is not valid JSON', async t => {
  const environment = { ARC_LOCAL_ROOT: await temporaryRoot(t) };
  const instance = await prepareInstance('/src/one', environment);
  await writeFile(instance.recordFile, '{ truncated');
  await assert.rejects(prepareInstance('/src/one', environment), error => error.message === `${instance.recordFile} is not valid JSON.`);
});

test('leaves no temporary file behind when a JSON file cannot be replaced', async t => {
  const directory = await temporaryRoot(t);
  const target = join(directory, 'runtime.json');
  await mkdir(target);
  await assert.rejects(writeJson(target, { version: 1 }));
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});

test('reports whether a port is free', async t => {
  const server = createServer();
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  assert.equal(await portAvailable(port), false);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await portAvailable(port), true);
});

test('reports a port held only on the IPv6 loopback as taken', async t => {
  const server = createServer();
  t.after(() => server.close());
  server.listen(0, '::1');
  try { await once(server, 'listening'); }
  catch { t.skip('The IPv6 loopback address is unavailable.'); return; }
  const { port } = server.address();
  assert.equal(await portAvailable(port), false);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await portAvailable(port), true);
});

test('lists instances with their run records', async t => {
  const environment = { ARC_LOCAL_ROOT: await temporaryRoot(t) };
  assert.deepEqual(await listInstances(environment), []);
  const one = await prepareInstance('/src/one', environment);
  await prepareInstance('/src/two', environment);
  await writeJson(one.runtimeFile, { version: 1, runnerPid: 1, controllerPid: 2 });
  const listed = await listInstances(environment);
  assert.deepEqual(listed.map(item => item.record.source).sort(), ['/src/one', '/src/two']);
  assert.equal(listed.find(item => item.record.source === '/src/one').runtime.controllerPid, 2);
});

test('treats run records of exited processes as stale', async t => {
  const directory = await temporaryRoot(t);
  const pid = await exitedPid();
  assert.equal(await runState(directory, undefined), 'stopped');
  assert.equal(await runState(directory, { runnerPid: pid, controllerPid: pid }), 'stale');
  // A live process that is not this instance's runner does not count as running.
  assert.equal(await runState(directory, { runnerPid: process.pid, controllerPid: pid }), 'stale');
});

test('recognizes this instance runner and an orphaned Controller', async t => {
  const directory = await temporaryRoot(t);
  const runner = await idleProcess(t, 'scripts/local/runner.mjs', directory);
  const controller = await idleProcess(t, 'cli.js', 'foreground');
  const runtime = { runnerPid: runner.pid, controllerPid: controller.pid };
  assert.equal(await runState(directory, runtime), 'running');
  // The runner must be started for exactly this instance directory.
  assert.equal(await runState(`${directory}-other`, runtime), 'orphaned');
  assert.equal(await runState(directory.slice(0, -1), runtime), 'orphaned');
});

test('does not mistake an unknown process state for a stopped instance', async t => {
  const directory = await temporaryRoot(t);
  const path = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.rejects(runState(directory, { runnerPid: process.pid, controllerPid: process.pid }), /Could not inspect process/);
  } finally { process.env.PATH = path; }
});

test('serializes operations on one instance', async t => {
  const directory = await temporaryRoot(t);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const first = withLock(directory, async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  await assert.rejects(withLock(directory, async () => undefined), /Another local command/);
  finish.resolve();
  await first;
  assert.equal(await withLock(directory, async () => 'ran'), 'ran');
  await assert.rejects(withLock(directory, async () => { throw new Error('failed'); }), /failed/);
  assert.equal(await withLock(directory, async () => 'ran again'), 'ran again');
});

test('reports a lock left by a killed command instead of taking it over', async t => {
  const directory = await temporaryRoot(t);
  await mkdir(join(directory, 'operation.lock'));
  await assert.rejects(withLock(directory, async () => 'ran'), /remove .*operation\.lock/);
  assert.ok((await stat(join(directory, 'operation.lock'))).isDirectory());
});

test('releases the lock when the command is terminated', async t => {
  const directory = await temporaryRoot(t);
  const module = pathToFileURL(join(import.meta.dirname, 'instance.mjs')).href;
  const script = `import { withLock } from ${JSON.stringify(module)};
await withLock(process.argv[1], async () => { process.stdout.write('locked\\n'); await new Promise(() => setInterval(() => {}, 1000)); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGTERM');
  await assert.rejects(stat(join(directory, 'operation.lock')), { code: 'ENOENT' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/local/instance.test.mjs`
Expected: FAIL with `Cannot find module '.../scripts/local/instance.mjs'`.

- [ ] **Step 3: Implement `scripts/local/instance.mjs`**

```javascript
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Instances live under one root outside every repository. */
export function localRoot(environment = process.env) {
  return environment.ARC_LOCAL_ROOT ? resolve(environment.ARC_LOCAL_ROOT) : join(homedir(), '.agent-remote-control-dev');
}

/** Stable for a checkout path and readable in listings. */
export function instanceName(source) {
  const label = basename(source).replace(/[^A-Za-z0-9._-]/g, '-') || 'checkout';
  return `${label}-${createHash('sha256').update(source).digest('hex').slice(0, 8)}`;
}

export function instanceFiles(directory) {
  return {
    directory,
    recordFile: join(directory, 'instance.json'),
    runtimeFile: join(directory, 'runtime.json'),
    relay: join(directory, 'relay'),
    controller: join(directory, 'controller'),
    workspace: join(directory, 'workspace'),
    logs: join(directory, 'logs'),
  };
}

export async function readJson(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try { return JSON.parse(text); }
  catch { throw new Error(`${path} is not valid JSON.`); }
}

export async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

/** Creates the file with its full content or leaves an existing one untouched; readers never see a partial file. */
async function createJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { await link(temporary, path); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  finally { await rm(temporary, { force: true }); }
}

export async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function canListen(port, host) {
  const server = createServer();
  try { server.listen(port, host); await once(server, 'listening'); return true; }
  catch (error) { return host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code); }
  finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}

/** Browsers may resolve localhost to either loopback address, so both must be free. */
export async function portAvailable(port) {
  return await canListen(port, '127.0.0.1') && await canListen(port, '::1');
}

/** The port is chosen once: the local identity is bound to the instance origin. */
export async function prepareInstance(source, environment = process.env) {
  const files = instanceFiles(join(localRoot(environment), 'instances', instanceName(source)));
  for (const directory of [files.directory, files.relay, files.controller, files.workspace, files.logs]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  let record = await readJson(files.recordFile);
  if (record && record.source !== source) throw new Error(`${files.directory} belongs to ${record.source}.`);
  if (!record) {
    const port = await freePort();
    const created = { version: 1, name: basename(files.directory), source, port, origin: `http://localhost:${port}`, createdAt: new Date().toISOString() };
    record = await createJson(files.recordFile, created) ? created : await readJson(files.recordFile);
  }
  return { ...files, record };
}

export async function findInstance(source, environment = process.env) {
  const files = instanceFiles(join(localRoot(environment), 'instances', instanceName(source)));
  const record = await readJson(files.recordFile);
  return record?.source === source ? { ...files, record } : undefined;
}

export async function listInstances(environment = process.env) {
  const root = join(localRoot(environment), 'instances');
  let names;
  try { names = await readdir(root); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const instances = [];
  for (const name of names.sort()) {
    const files = instanceFiles(join(root, name));
    const record = await readJson(files.recordFile).catch(() => undefined);
    if (record) instances.push({ ...files, record, runtime: await readJson(files.runtimeFile).catch(() => undefined) });
  }
  return instances;
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export async function processCommand(pid) {
  if (!processAlive(pid)) return undefined;
  try {
    const { stdout } = await exec('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { timeout: 15_000 });
    return stdout.trim() || undefined;
  } catch (error) {
    // ps exits 1 when the process is gone; anything else leaves the state unknown, not stopped.
    if (error.code === 1) return undefined;
    throw new Error(`Could not inspect process ${pid}: ${error.message}`);
  }
}

/** A recorded PID counts only while it still runs the command this instance started. */
export async function runState(directory, runtime) {
  if (!runtime) return 'stopped';
  const runner = await processCommand(runtime.runnerPid);
  if (runner?.includes('scripts/local/runner.mjs') && runner.endsWith(` ${directory}`)) return 'running';
  return (await processCommand(runtime.controllerPid))?.includes('cli.js foreground') ? 'orphaned' : 'stale';
}

/** Operations on one instance run one at a time; a lock left by a killed command is reported, not taken over. */
export async function withLock(directory, action) {
  const lock = join(directory, 'operation.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another local command is changing this instance. If none is running, remove ${lock}.`);
  }
  const release = () => rmSync(lock, { recursive: true, force: true });
  const interrupted = signal => { release(); process.kill(process.pid, signal); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try { return await action(); }
  finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    release();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/local/instance.test.mjs`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/local/instance.mjs scripts/local/instance.test.mjs
git commit -m "feat(local): record per-checkout local instances

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Development Controller environment

**Files:**
- Create: `scripts/local/environment.mjs`
- Test: `scripts/local/environment.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `scripts/local/environment.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerEnvironment } from './environment.mjs';

const instance = { controller: '/dev/i/controller', workspace: '/dev/i/workspace', record: { source: '/src/.worktrees/feature-x' } };
const allowedParentVariables = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM', 'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'PATH'];
const instanceVariables = ['AGENT_HOST_STATE_DIR', 'AGENT_HOST_WORKSPACE', 'AGENT_HOST_ALLOWED_WORKSPACE_ROOTS', 'AGENT_HOST_NAME',
  'AGENT_HOST_TRUSTED_FULL_CONTROL', 'AGENT_HOST_CODEX_AUTO_START', 'AGENT_HOST_OPENCODE_AUTO_START'];
const defaultPath = '/usr/bin:/bin:/usr/sbin:/sbin';

test('passes only the allowlisted parent environment', () => {
  const environment = controllerEnvironment({
    HOME: '/home/me', USER: 'me', LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TMPDIR: '/tmp/me', SSH_AUTH_SOCK: '/tmp/agent', https_proxy: 'http://proxy',
    AGENT_HOST_TRUSTED_FULL_CONTROL: '1', AGENT_HOST_SERVER: 'https://production.example', AGENT_WINDOW_TOKEN: 'grant',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CODEX_HOME: '/elsewhere', npm_lifecycle_event: 'local', PATH: '/usr/bin',
    GATEWAY_TOKEN: 'gateway', RELAY_URL: 'https://relay.example', ANTHROPIC_API_KEY: 'key', OPENAI_API_KEY: 'key',
    NODE_OPTIONS: '--require x', XDG_CONFIG_HOME: '/home/me/.config', SHELL: undefined,
  }, instance);
  assert.deepEqual({ HOME: environment.HOME, USER: environment.USER, LANG: environment.LANG, LC_ALL: environment.LC_ALL, LC_CTYPE: environment.LC_CTYPE,
    TMPDIR: environment.TMPDIR, SSH_AUTH_SOCK: environment.SSH_AUTH_SOCK, https_proxy: environment.https_proxy },
  { HOME: '/home/me', USER: 'me', LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TMPDIR: '/tmp/me', SSH_AUTH_SOCK: '/tmp/agent', https_proxy: 'http://proxy' });
  for (const key of ['AGENT_WINDOW_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_HOME', 'npm_lifecycle_event', 'GATEWAY_TOKEN', 'RELAY_URL',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'XDG_CONFIG_HOME']) {
    assert.equal(environment[key], undefined, key);
  }
  assert.equal(environment.AGENT_HOST_SERVER, undefined);
  assert.equal(Object.hasOwn(environment, 'SHELL'), false);
  const allowed = new Set([...allowedParentVariables, ...instanceVariables]);
  assert.deepEqual(Object.keys(environment).filter(key => !allowed.has(key)), []);
});

test('pins restricted control over any inherited value', () => {
  assert.equal(controllerEnvironment({ AGENT_HOST_TRUSTED_FULL_CONTROL: '1' }, instance).AGENT_HOST_TRUSTED_FULL_CONTROL, '0');
  assert.equal(controllerEnvironment({}, instance).AGENT_HOST_TRUSTED_FULL_CONTROL, '0');
  // Restricted shared Codex refuses to run, so its trust setting stays at the Controller default.
  assert.equal(Object.hasOwn(controllerEnvironment({ AGENT_HOST_CODEX_TRUST_SHARED: '0' }, instance), 'AGENT_HOST_CODEX_TRUST_SHARED'), false);
});

test('removes package-manager shims from PATH', () => {
  const PATH = ['/repo/node_modules/.bin', '/usr/local/bin', '/repo/packages/x/node_modules/.bin', '', '/usr/bin'].join(':');
  assert.equal(controllerEnvironment({ PATH }, instance).PATH, '/usr/local/bin:/usr/bin');
});

test('keeps PATH entries that only resemble node_modules', () => {
  assert.equal(controllerEnvironment({ PATH: '/repo/node_modules_old/bin:/usr/bin' }, instance).PATH, '/repo/node_modules_old/bin:/usr/bin');
});

test('falls back to the system PATH when no entry remains', () => {
  assert.equal(controllerEnvironment({}, instance).PATH, defaultPath);
  assert.equal(controllerEnvironment({ PATH: '' }, instance).PATH, defaultPath);
  assert.equal(controllerEnvironment({ PATH: '/repo/node_modules/.bin:/x/node_modules/.bin' }, instance).PATH, defaultPath);
});

test('confines the Controller to the instance', () => {
  const environment = controllerEnvironment({}, instance);
  assert.equal(environment.AGENT_HOST_STATE_DIR, '/dev/i/controller');
  assert.equal(environment.AGENT_HOST_WORKSPACE, '/dev/i/workspace');
  assert.equal(environment.AGENT_HOST_ALLOWED_WORKSPACE_ROOTS, JSON.stringify(['/dev/i/workspace']));
  assert.equal(environment.AGENT_HOST_NAME, 'Dev · feature-x');
  assert.equal(environment.AGENT_HOST_CODEX_AUTO_START, '0');
  assert.equal(environment.AGENT_HOST_OPENCODE_AUTO_START, '0');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/local/environment.test.mjs`
Expected: FAIL with `Cannot find module '.../scripts/local/environment.mjs'`.

- [ ] **Step 3: Implement `scripts/local/environment.mjs`**

```javascript
import { basename, delimiter, sep } from 'node:path';

const allowedParentVariables = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM', 'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']);
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * The development Controller starts from an explicit environment: grants, nested-session markers and
 * trusted full control from the launching shell never reach it, and package-manager shims leave PATH.
 * Native profile variables are not set, so the user's default native profiles are shared.
 */
export function controllerEnvironment(parent, instance) {
  const environment = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && (allowedParentVariables.has(key) || key.startsWith('LC_'))) environment[key] = value;
  }
  const path = (parent.PATH ?? '').split(delimiter)
    .filter(entry => entry && !entry.split(sep).includes('node_modules')).join(delimiter);
  return {
    ...environment,
    PATH: path || systemPath,
    AGENT_HOST_STATE_DIR: instance.controller,
    AGENT_HOST_WORKSPACE: instance.workspace,
    AGENT_HOST_ALLOWED_WORKSPACE_ROOTS: JSON.stringify([instance.workspace]),
    AGENT_HOST_NAME: `Dev · ${basename(instance.record.source)}`,
    // Saved connection settings are merged under the environment, so only an explicit value overrides one
    // persisted in the instance state; leaving it absent would let a saved '1' lift the workspace policy.
    AGENT_HOST_TRUSTED_FULL_CONTROL: '0',
    // The instance never starts, restarts or updates the Codex daemon or OpenCode server; they belong to the user's Controller.
    AGENT_HOST_CODEX_AUTO_START: '0',
    AGENT_HOST_OPENCODE_AUTO_START: '0',
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/local/environment.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/local/environment.mjs scripts/local/environment.test.mjs
git commit -m "feat(local): give the development Controller an explicit environment

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Runner

**Files:**
- Create: `scripts/local/runner.mjs`
- Test: `scripts/local/runner.test.mjs`

The runner reuses `containerEnvironment` from `scripts/controller/entrypoint.mjs`: with a saved `connection.json` in the state directory it drops the server and key (the Controller reuses its device credential) and refuses a state directory that belongs to another Relay.

- [ ] **Step 1: Write the failing tests**

Create `scripts/local/runner.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { prepareInstance, runState } from './instance.mjs';
import { startInstance } from './runner.mjs';

const runnerScript = fileURLToPath(new URL('./runner.mjs', import.meta.url));

// Registers its stop handler and saves the issued credential before announcing the start.
const fakeController = `import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const state = process.env.AGENT_HOST_STATE_DIR;
if (process.argv[2] !== 'foreground') process.exit(5);
process.on('SIGTERM', async () => { await writeFile(join(state, 'stopped'), 'yes'); process.exit(0); });
await mkdir(state, { recursive: true });
try { await stat(join(state, 'exit-now')); process.exit(7); } catch {}
if (process.env.AGENT_HOST_REMOTE_KEY) {
  await writeFile(join(state, 'connection.json'), JSON.stringify({ serverUrl: process.env.AGENT_HOST_SERVER, remoteKey: 'issued-device', environment: {} }));
}
await appendFile(join(state, 'starts.jsonl'), JSON.stringify({ env: process.env, cwd: process.cwd() }) + '\\n');
setInterval(() => {}, 1000);
`;

// Leaves a descendant in its process group; files in its state directory select how it ends.
const leavesGrandchild = `import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const state = process.env.AGENT_HOST_STATE_DIR;
process.on('SIGTERM', existsSync(join(state, 'ignore-stop')) ? () => {} : () => process.exit(0));
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
await mkdir(state, { recursive: true });
await writeFile(join(state, 'grandchild'), String(grandchild.pid));
if (existsSync(join(state, 'exit-now'))) process.exit(3);
setInterval(() => {}, 1000);
`;

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitUntil(condition, message) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await delay(20);
  }
  throw new Error(message);
}

const exists = path => stat(path).then(() => true, () => false);

/** The runner's own report of an unrequested Controller exit is asserted, not printed into the test output. */
function captureStderr(t) {
  const written = [];
  t.mock.method(process.stderr, 'write', chunk => { written.push(String(chunk)); return true; });
  return written;
}

async function fixture(t, controller = fakeController) {
  const root = await mkdtemp(join(tmpdir(), 'arc-local-runner-'));
  const cleanups = [];
  // Cleanups run last-registered first, and every process is gone before the directory it runs in is removed.
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  const controllerScript = join(root, 'controller.mjs');
  await writeFile(controllerScript, controller);
  const environment = { ARC_LOCAL_ROOT: join(root, 'local'), HOME: join(root, 'home'), PATH: '/usr/bin:/bin', TMPDIR: tmpdir(),
    AGENT_HOST_TRUSTED_FULL_CONTROL: '1', CLAUDECODE: '1' };
  const instance = await prepareInstance(join(root, 'checkout'), environment);
  let invitations = 0;
  let listens = 0;
  const closed = [];
  const received = [];
  const behaviour = {};
  const createServer = async options => {
    received.push(options);
    assert.equal(options.origin, instance.record.origin);
    assert.equal(options.stateDir, instance.relay);
    const server = createHttpServer((_request, response) => response.end('ready'));
    return {
      listen: (port, bind) => new Promise((resolve, reject) => { listens++; server.once('error', reject); server.listen(port, bind, resolve); }),
      close: () => new Promise(resolve => { closed.push(true); server.close(() => resolve()); }),
      getConnection: async () => {
        invitations++;
        return behaviour.invite ? behaviour.invite(options.origin) : { serverUrl: options.origin, remoteKey: 'one-time-invite' };
      },
    };
  };
  const starts = async () => (await readFile(join(instance.controller, 'starts.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  const waitForStarts = async count => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const seen = await starts();
      if (seen.length >= count) return seen;
      await delay(20);
    }
    throw new Error('The Controller fixture did not start.');
  };
  const start = async options => {
    const running = await startInstance({ directory: instance.directory, environment, createServer, controllerScript, ...options });
    let finished = false;
    running.done.then(() => { finished = true; }, () => { finished = true; });
    cleanups.push(async () => {
      if (!finished) try { process.kill(-running.controllerPid, 'SIGKILL'); } catch {}
      await running.done.catch(() => {});
    });
    return running;
  };
  /** Waits for the Controller's descendant and makes sure it cannot outlive the test. */
  const grandchild = async () => {
    const pid = Number(await waitUntil(() => readFile(join(instance.controller, 'grandchild'), 'utf8').catch(() => ''), 'The descendant did not start.'));
    cleanups.push(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
    return pid;
  };
  return { root, environment, instance, closed, received, behaviour, waitForStarts, grandchild, start,
    invitations: () => invitations, listens: () => listens, onCleanup: cleanup => cleanups.push(cleanup) };
}

test('pairs once, then restarts with the saved device credential', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  let running = await f.start();
  assert.equal(await (await fetch(running.origin.replace('localhost', '127.0.0.1'))).text(), 'ready');
  const [first] = await f.waitForStarts(1);
  assert.equal(first.env.AGENT_HOST_REMOTE_KEY, 'one-time-invite');
  assert.equal(first.env.AGENT_HOST_SERVER, f.instance.record.origin);
  assert.equal(first.env.AGENT_HOST_ALLOWED_WORKSPACE_ROOTS, JSON.stringify([f.instance.workspace]));
  assert.equal(first.env.AGENT_HOST_TRUSTED_FULL_CONTROL, '0');
  assert.equal(first.env.CLAUDECODE, undefined);
  assert.equal(first.cwd, await realpath(f.instance.workspace));
  const runtime = JSON.parse(await readFile(f.instance.runtimeFile, 'utf8'));
  assert.equal(runtime.version, 1);
  assert.equal(runtime.runnerPid, process.pid);
  assert.equal(runtime.controllerPid, running.controllerPid);
  // The stand-in checkout is not a git repository, so its build identity is unknown.
  assert.equal(runtime.revision, 'unknown');
  assert.equal(runtime.dirty, true);
  assert.ok(Number.isFinite(Date.parse(runtime.startedAt)));
  assert.equal(await running.close(), 0);
  assert.equal(await readFile(join(f.instance.controller, 'stopped'), 'utf8'), 'yes');
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });

  running = await f.start();
  const [, second] = await f.waitForStarts(2);
  assert.equal(second.env.AGENT_HOST_REMOTE_KEY, undefined);
  assert.equal(second.env.AGENT_HOST_SERVER, undefined);
  assert.equal(f.invitations(), 1);
  assert.equal(await running.close(), 0);
});

test('hands the site its state directory and the built web files', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await (await f.start()).close();
  assert.equal(f.received[0].webDist, join(f.instance.record.source, 'dist/relay/web'));
  await (await f.start({ environment: { ...f.environment, ARC_LOCAL_WEB_DIST: '/elsewhere/web' } })).close();
  assert.equal(f.received[1].webDist, '/elsewhere/web');
});

test('stops serving when the Controller exits on its own', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const stderr = captureStderr(t);
  await writeFile(join(f.instance.controller, 'exit-now'), '');
  const running = await f.start();
  assert.equal(await running.done, 7);
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
  assert.deepEqual(stderr, ['Controller exited with code 7; the site was stopped.\n']);
});

test('close after the Controller already exited reports its code', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  captureStderr(t);
  await writeFile(join(f.instance.controller, 'exit-now'), '');
  const running = await f.start();
  assert.equal(await running.done, 7);
  assert.equal(await running.close(), 7);
  assert.equal(await running.close(), 7);
  assert.equal(f.closed.length, 1);
});

test('kills the whole Controller process group when it ignores the stop request', { timeout: 30000 }, async t => {
  const f = await fixture(t, leavesGrandchild);
  await writeFile(join(f.instance.controller, 'ignore-stop'), '');
  const running = await f.start({ stopGraceMs: 200 });
  const grandchild = await f.grandchild();
  assert.equal(alive(grandchild), true);
  assert.equal(await running.close(), 0);
  await waitUntil(() => !alive(grandchild), 'The descendant survived the stop.');
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
});

test('sweeps the Controller process group after it stops on request', { timeout: 30000 }, async t => {
  const f = await fixture(t, leavesGrandchild);
  const running = await f.start();
  const grandchild = await f.grandchild();
  assert.equal(await running.close(), 0);
  await waitUntil(() => !alive(grandchild), 'The descendant of a Controller that stopped cleanly survived.');
});

test('sweeps the Controller process group after it exits on its own', { timeout: 30000 }, async t => {
  const f = await fixture(t, leavesGrandchild);
  captureStderr(t);
  await writeFile(join(f.instance.controller, 'exit-now'), '');
  const running = await f.start();
  const grandchild = await f.grandchild();
  assert.equal(await running.done, 3);
  await waitUntil(() => !alive(grandchild), 'The descendant of a Controller that exited survived.');
});

test('a Controller that cannot be spawned ends the start and leaves nothing behind', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await rm(f.instance.workspace, { recursive: true });
  await assert.rejects(f.start(), /ENOENT/);
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
});

test('a site that cannot listen is closed and the start fails', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const occupied = createHttpServer();
  await new Promise(resolve => occupied.listen(f.instance.record.port, '127.0.0.1', resolve));
  f.onCleanup(() => new Promise(resolve => occupied.close(() => resolve())));
  await assert.rejects(f.start(), { code: 'EADDRINUSE' });
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
});

test('refuses an invitation for another site or without a key', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const { origin } = f.instance.record;
  for (const invitation of [{ serverUrl: 'http://localhost:1', remoteKey: 'key' }, { serverUrl: origin, remoteKey: '' }, { serverUrl: origin }, undefined]) {
    f.behaviour.invite = () => invitation;
    await assert.rejects(f.start(), /The local site did not return a matching Controller invitation\./);
  }
  assert.equal(f.closed.length, 4);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
  assert.equal(await exists(join(f.instance.logs, 'controller.log')), false);
});

test('refuses Controller state saved for another site before serving or spawning', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.instance.controller, 'connection.json'),
    JSON.stringify({ serverUrl: 'http://localhost:1', remoteKey: 'saved-device', environment: {} }));
  await assert.rejects(f.start(), error => error.message === "This instance's Controller state belongs to another site origin. Remove the instance with pnpm local remove --yes."
    && /another Relay/.test(error.cause?.message));
  assert.equal(f.listens(), 0);
  assert.equal(f.invitations(), 0);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
  assert.equal(await exists(join(f.instance.logs, 'controller.log')), false);
});

test('names an unusable saved Controller connection instead of blaming the origin', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const connection = join(f.instance.controller, 'connection.json');
  for (const content of ['{}', 'not json', JSON.stringify({ serverUrl: 'http://localhost:1', remoteKey: '' })]) {
    await writeFile(connection, content);
    await assert.rejects(f.start(), error => {
      assert.match(error.message, /^The instance's saved Controller connection is unreadable \(.+\)\. Check .*connection\.json\.$/);
      assert.ok(error.message.includes(connection), error.message);
      assert.doesNotMatch(error.message, /another site origin|pnpm local remove/);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }
  assert.equal(f.listens(), 0);
  assert.equal(f.invitations(), 0);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
  assert.equal(await exists(join(f.instance.logs, 'controller.log')), false);
});

test('an aborted start closes the site, removes the runtime file and never spawns the Controller', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  f.behaviour.invite = () => { abort.abort(); return new Promise(() => {}); };
  await assert.rejects(f.start({ signal: abort.signal }), { name: 'AbortError' });
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
  assert.equal(await exists(join(f.instance.logs, 'controller.log')), false);

  // A start that is stopped before it began does nothing at all.
  f.received.length = 0;
  await assert.rejects(f.start({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(f.received.length, 0);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
});

// The command-line entry, run the way `pnpm local up` runs it, against a stand-in checkout.
const standInSite = `import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export async function createDevboxServer({ origin, stateDir }) {
  const server = createServer((_request, response) => response.end('ready'));
  // The real site can leave handles open after close(); the runner must still exit.
  setInterval(() => {}, 1000);
  return {
    listen: (port, bind) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); }),
    close: () => new Promise(resolve => server.close(() => resolve())),
    getConnection: async () => {
      await writeFile(join(stateDir, 'inviting'), '');
      await delay(Number(process.env.FIXTURE_INVITE_DELAY));
      return { serverUrl: origin, remoteKey: 'one-time-invite' };
    },
  };
}
`;

async function commandLine(t, { inviteDelayMs = 0, beforeStart } = {}) {
  const f = await fixture(t);
  const checkout = join(f.root, 'checkout');
  await mkdir(join(checkout, 'dist/devbox'), { recursive: true });
  await mkdir(join(checkout, 'packages/agent-host/dist'), { recursive: true });
  await writeFile(join(checkout, 'package.json'), '{"type":"module"}');
  await writeFile(join(checkout, 'dist/devbox/server.mjs'), standInSite);
  await writeFile(join(checkout, 'packages/agent-host/dist/cli.js'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.AGENT_HOST_STATE_DIR + '/pid', String(process.pid));\n` + fakeController);
  await beforeStart?.(f);
  const child = spawn(process.execPath, [runnerScript, f.instance.directory],
    { env: { ...f.environment, FIXTURE_INVITE_DELAY: String(inviteDelayMs) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  // 'close' rather than 'exit': the output is complete once the streams have ended.
  const exit = once(child, 'close').then(([code, signal]) => ({ code, signal }));
  const controllerPid = () => readFile(join(f.instance.controller, 'pid'), 'utf8').then(Number, () => undefined);
  f.onCleanup(async () => { const pid = await controllerPid(); if (pid) try { process.kill(-pid, 'SIGKILL'); } catch {} });
  f.onCleanup(() => child.kill('SIGKILL'));
  const promptly = async () => {
    const result = await Promise.race([exit, delay(5000).then(() => 'still running')]);
    assert.notEqual(result, 'still running', 'The runner did not exit promptly.');
    return result;
  };
  return { f, child, exit, promptly, output: () => output, controllerPid };
}

test('a stop during startup never spawns the Controller and exits at once', { timeout: 30000 }, async t => {
  const c = await commandLine(t, { inviteDelayMs: 60_000 });
  await waitUntil(() => exists(join(c.f.instance.relay, 'inviting')), 'The runner did not reach the invitation.');
  // The instance is visible, and stoppable, from the first moment.
  const runtime = JSON.parse(await readFile(c.f.instance.runtimeFile, 'utf8'));
  assert.deepEqual(Object.keys(runtime).sort(), ['runnerPid', 'startedAt', 'version']);
  assert.equal(runtime.runnerPid, c.child.pid);
  assert.equal(await runState(c.f.instance.directory, runtime), 'running');
  c.child.kill('SIGTERM');
  assert.deepEqual(await c.promptly(), { code: 0, signal: null });
  await assert.rejects(stat(c.f.instance.runtimeFile), { code: 'ENOENT' });
  assert.equal(await c.controllerPid(), undefined);
  assert.equal(await exists(join(c.f.instance.controller, 'starts.jsonl')), false);
  assert.equal(await exists(join(c.f.instance.logs, 'controller.log')), false);
  await assert.rejects(fetch(c.f.instance.record.origin.replace('localhost', '127.0.0.1')));
});

test('a stop sent to a running runner stops the Controller even if the site leaves handles open', { timeout: 30000 }, async t => {
  const c = await commandLine(t);
  await waitUntil(() => /Serving /.test(c.output()), 'The runner did not report that it was serving.');
  await c.f.waitForStarts(1);
  const pid = await c.controllerPid();
  assert.match(c.output(), new RegExp(`Controller pid ${pid}\\.`));
  const runtime = JSON.parse(await readFile(c.f.instance.runtimeFile, 'utf8'));
  assert.equal(runtime.runnerPid, c.child.pid);
  assert.equal(runtime.controllerPid, pid);
  assert.equal(await runState(c.f.instance.directory, runtime), 'running');
  c.child.kill('SIGTERM');
  assert.deepEqual(await c.promptly(), { code: 0, signal: null });
  assert.equal(await readFile(join(c.f.instance.controller, 'stopped'), 'utf8'), 'yes');
  assert.equal(alive(pid), false);
  await assert.rejects(stat(c.f.instance.runtimeFile), { code: 'ENOENT' });
});

test('reports a Controller that exits on its own and exits with its code', { timeout: 30000 }, async t => {
  const c = await commandLine(t, { beforeStart: f => writeFile(join(f.instance.controller, 'exit-now'), '') });
  assert.deepEqual(await c.promptly(), { code: 7, signal: null });
  assert.match(c.output(), /Controller exited with code 7; the site was stopped\./);
  await assert.rejects(stat(c.f.instance.runtimeFile), { code: 'ENOENT' });
  await assert.rejects(fetch(c.f.instance.record.origin.replace('localhost', '127.0.0.1')));
});

test('prints a usage line when no instance directory is given', { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [runnerScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.match(output, /Usage: node scripts\/local\/runner\.mjs <instance directory>/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/local/runner.test.mjs`
Expected: FAIL with `Cannot find module '.../scripts/local/runner.mjs'`.

- [ ] **Step 3: Implement `scripts/local/runner.mjs`**

```javascript
import { spawn } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { containerEnvironment } from '../controller/entrypoint.mjs';
import { controllerBuildProvenance } from '../lib/build-provenance.mjs';
import { controllerEnvironment } from './environment.mjs';
import { instanceFiles, readJson, writeJson } from './instance.mjs';

/** Settles like the promise, but rejects with the signal's reason as soon as the signal aborts. */
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((settle, fail) => {
    const onAbort = () => fail(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    // Attached either way, so a promise that loses the race cannot become an unhandled rejection.
    promise.then(settle, fail).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * One runner owns one instance: the site first, then the Controller paired with it.
 * `runtime.json` exists from the first moment, so a runner that is still starting can be seen and stopped;
 * aborting `signal` ends a start that has not spawned the Controller yet.
 */
export async function startInstance({ directory, environment = process.env, createServer, controllerScript, signal, stopGraceMs = 15_000 }) {
  const files = instanceFiles(directory);
  const record = await readJson(files.recordFile);
  if (!record) throw new Error(`${directory} has no instance record.`);
  signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  await writeJson(files.runtimeFile, { version: 1, runnerPid: process.pid, startedAt });
  let server;
  let child;
  let exited;
  let spawnError;
  try {
    // Refused before anything is served or spawned: a state directory saved for another origin cannot be reused.
    const parentEnvironment = controllerEnvironment(environment, { ...files, record });
    let native;
    try { native = await containerEnvironment({ ...parentEnvironment, AGENT_HOST_SERVER: record.origin }); }
    catch (error) {
      // Only the origin mismatch is cured by removing the instance; an unreadable or invalid file needs a look, not a wipe.
      throw new Error(/another Relay/.test(error.message)
        ? "This instance's Controller state belongs to another site origin. Remove the instance with pnpm local remove --yes."
        : `The instance's saved Controller connection is unreadable (${error.message}). Check ${join(files.controller, 'connection.json')}.`, { cause: error });
    }
    signal?.throwIfAborted();
    const factory = createServer ?? (await import(pathToFileURL(join(record.source, 'dist/devbox/server.mjs')).href)).createDevboxServer;
    server = await factory({ origin: record.origin, stateDir: files.relay,
      webDist: environment.ARC_LOCAL_WEB_DIST ?? join(record.source, 'dist/relay/web') });
    await server.listen(record.port, '127.0.0.1');
    // A saved device credential removed the server above; only a first start needs an invitation.
    const [invitation, provenance] = await abortable(Promise.all([
      native.AGENT_HOST_SERVER ? server.getConnection() : undefined,
      controllerBuildProvenance(record.source, {}).catch(() => ({ revision: 'unknown', dirty: true })),
    ]), signal);
    if (native.AGENT_HOST_SERVER) {
      if (invitation?.serverUrl !== record.origin || typeof invitation.remoteKey !== 'string' || !invitation.remoteKey) {
        throw new Error('The local site did not return a matching Controller invitation.');
      }
      native.AGENT_HOST_REMOTE_KEY = invitation.remoteKey;
    }
    signal?.throwIfAborted();
    const log = await open(join(files.logs, 'controller.log'), 'w', 0o600);
    try {
      // The last check and the spawn are adjacent, so an aborted start never spawns the Controller.
      signal?.throwIfAborted();
      child = spawn(process.execPath, [controllerScript ?? join(record.source, 'packages/agent-host/dist/cli.js'), 'foreground'],
        { env: native, cwd: files.workspace, stdio: ['ignore', log.fd, log.fd], detached: true });
      // Listen before any await: a Controller that fails to spawn or exits at once must still end the runner,
      // and an 'error' event without a listener would crash it.
      child.on('error', error => { spawnError ??= error; });
      exited = new Promise(resolveExit => child.once('close', code => resolveExit(spawnError ? 1 : code ?? 1)));
    } finally { await log.close(); }
    if (child.pid === undefined) { await exited; throw spawnError; }
    await writeJson(files.runtimeFile, { version: 1, runnerPid: process.pid, controllerPid: child.pid,
      revision: provenance.revision, dirty: provenance.dirty, startedAt });
  } catch (error) {
    if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { await server?.close(); } catch {}
    await rm(files.runtimeFile, { force: true }).catch(() => {});
    throw error;
  }
  let stopping = false;
  let timer;
  const done = exited.then(async code => {
    clearTimeout(timer);
    // The Controller leads its own process group: whatever it left running goes with it.
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { await server.close(); }
    finally { await rm(files.runtimeFile, { force: true }).catch(() => {}); }
    if (stopping) return 0;
    process.stderr.write(`Controller exited with code ${code}; the site was stopped.\n`);
    return code || 1;
  });
  return {
    origin: record.origin,
    controllerPid: child.pid,
    done,
    async close() {
      if (!stopping && child.exitCode === null && child.signalCode === null) {
        stopping = true;
        child.kill('SIGTERM');
        // A Controller that ignores the request is killed together with everything it started.
        timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, stopGraceMs);
        timer.unref();
      }
      return done;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) {
    process.stderr.write('Usage: node scripts/local/runner.mjs <instance directory>\n');
    process.exit(1);
  }
  const abort = new AbortController();
  let running;
  let interrupted = false;
  const stop = () => { interrupted = true; abort.abort(); running?.close().catch(() => undefined); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let code;
  try {
    running = await startInstance({ directory: resolve(process.argv[2]), signal: abort.signal });
    // A stop that landed while the Controller was being spawned could no longer abort the start.
    if (interrupted) await running.close();
    else process.stdout.write(`Serving ${running.origin}; Controller pid ${running.controllerPid}.\n`);
    code = await running.done;
  } catch (error) {
    if (abort.signal.aborted && error === abort.signal.reason) code = 0;
    else {
      process.stderr.write(`${error.stack ?? error.message}\n${error.cause ? `Caused by: ${error.cause.message}\n` : ''}`);
      code = 1;
    }
  }
  // The site may leave handles open after close(); nothing is left for the runner to do.
  process.exit(code);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/local/runner.test.mjs`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/local/runner.mjs scripts/local/runner.test.mjs
git commit -m "feat(local): run a local site with a paired development Controller

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Signed-in user session, API and screenshot

**Files:**
- Create: `scripts/local/session.mjs`
- Test: `scripts/local/session.test.mjs`

The instance's Devbox identity signs a cookie-less, same-origin request to `/auth/status` in and returns session cookies plus the user's `basePath` (`/u/<id>/`). This is the same exchange `pairController` in `packages/agent-remote-lab/src/server/devbox.ts` uses.

- [ ] **Step 1: Write the failing tests**

Create `scripts/local/session.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { signedInUser, userApi } from './session.mjs';

async function fakeInstance(t, { statusCode = 200 } = {}) {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ method: request.method, url: request.url, cookie: request.headers.cookie, origin: request.headers.origin });
    if (request.url === '/auth/status') {
      response.writeHead(statusCode, { 'content-type': 'application/json', 'set-cookie': ['devbox_session=s1; Path=/; HttpOnly', 'devbox_login=; Max-Age=0'] });
      return response.end(JSON.stringify({ user: { id: 'devbox' }, basePath: '/u/abc/' }));
    }
    if (request.url === '/u/abc/v1/remote/hosts') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end('{"hosts":[]}');
    }
    if (request.url === '/auth/logout') { response.writeHead(204); return response.end(); }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, calls };
}

test('calls the user API with the local session and signs out', async t => {
  const f = await fakeInstance(t);
  assert.deepEqual(await userApi(f.origin, 'v1/remote/hosts'), { status: 200, body: '{"hosts":[]}' });
  assert.deepEqual(f.calls.map(call => `${call.method} ${call.url}`), ['GET /auth/status', 'GET /u/abc/v1/remote/hosts', 'POST /auth/logout']);
  const api = f.calls[1];
  assert.equal(api.cookie, 'devbox_session=s1; devbox_login=');
  assert.equal(api.origin, f.origin);
  assert.equal(f.calls[0].cookie, undefined);
});

test('rejects paths outside the user API', async () => {
  await assert.rejects(userApi('http://127.0.0.1:9', '/auth/status'), /start with v1\//);
});

test('reports an unavailable local identity', async t => {
  const f = await fakeInstance(t, { statusCode: 401 });
  await assert.rejects(signedInUser(f.origin), /local identity is unavailable \(401\)/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/local/session.test.mjs`
Expected: FAIL with `Cannot find module '.../scripts/local/session.mjs'`.

- [ ] **Step 3: Implement `scripts/local/session.mjs`**

```javascript
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** Runs an action as the instance's local user; every local request is signed in, and signed out afterwards. */
export async function withUserSession(origin, action) {
  const status = await fetch(origin + '/auth/status', { signal: AbortSignal.timeout(10_000) });
  if (!status.ok) {
    await status.body?.cancel();
    throw new Error(`The local identity is unavailable (${status.status}).`);
  }
  const state = await status.json();
  if (state.user?.id !== 'devbox' || typeof state.basePath !== 'string' || !state.basePath.startsWith('/u/')) {
    throw new Error('The instance did not sign in its local user.');
  }
  const headers = { cookie: status.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), origin };
  try { return await action({ basePath: state.basePath, headers }); }
  finally {
    const logout = await fetch(origin + '/auth/logout', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    await logout?.body?.cancel();
  }
}

export function signedInUser(origin) {
  return withUserSession(origin, async () => true);
}

export async function userApi(origin, path, { method = 'GET', data } = {}) {
  if (!/^v1\/\S*$/.test(path)) throw new Error('API paths start with v1/, for example v1/remote/hosts.');
  return withUserSession(origin, async ({ basePath, headers }) => {
    const response = await fetch(origin + basePath + path, { method, signal: AbortSignal.timeout(30_000),
      headers: data === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: data }) });
    return { status: response.status, body: await response.text() };
  });
}

/** A fresh headless context is signed in by the instance; the user's own browsers are never used. */
export async function screenshot({ source, origin, path = '/', output, viewport = '1440x900', waitFor = 'main.lab-shell', fullPage = false }) {
  const [width, height] = viewport.split('x').map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || height < 200) throw new Error('Viewport must look like 1440x900.');
  if (!path.startsWith('/')) throw new Error('Page paths start with /.');
  const { chromium } = createRequire(join(source, 'packages/agent-remote-lab/package.json'))('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
    await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator(waitFor).first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: output, fullPage });
  } finally { await browser.close(); }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/local/session.test.mjs`
Expected: PASS, 3 tests. `screenshot` is covered by the integration test in Task 6.

- [ ] **Step 5: Commit**

```bash
git add scripts/local/session.mjs scripts/local/session.test.mjs
git commit -m "feat(local): call the instance as its signed-in local user

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: `pnpm local` command

**Files:**
- Create: `scripts/local/command.mjs`
- Test: `scripts/local/command.test.mjs`
- Modify: `package.json` (scripts)
- Modify: `scripts/run-tests.mjs` (commands, outer deadline)

- [ ] **Step 1: Write the failing integration test**

The test uses the real Devbox server and the real development Controller with a temporary HOME, a PATH without native CLIs and a fixture web page, so it never reads or writes the real native profiles. Create `scripts/local/command.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { processAlive } from './instance.mjs';

const run = promisify(execFile);
const source = resolve(import.meta.dirname, '../..');
const command = join(source, 'scripts/local/command.mjs');
// The temporary HOME hides Playwright's default browser cache, so name the real one explicitly.
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
  ?? join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
let root;
let environment;
const local = (...args) => run(process.execPath, [command, ...args], { cwd: source, env: environment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });

before(async () => {
  if (!existsSync(join(source, 'packages/agent-host/dist/cli.js'))) {
    throw new Error('Build the Controller first: pnpm --filter @orchardworks/agent-remote-controller... run build');
  }
  await run(process.execPath, [join(source, 'scripts/build-devbox.mjs')], { cwd: source, timeout: 60_000 });
  root = await mkdtemp(join(tmpdir(), 'arc-local-command-'));
  const web = join(root, 'web');
  await mkdir(web);
  await writeFile(join(web, 'index.html'), '<!doctype html><html><head></head><body><main class="lab-shell">Local fixture</main></body></html>');
  environment = { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: tmpdir(), ARC_LOCAL_ROOT: join(root, 'local'),
    ARC_LOCAL_WEB_DIST: web, ARC_LOCAL_READY_TIMEOUT_MS: '60000', PLAYWRIGHT_BROWSERS_PATH: browsers };
  await mkdir(environment.HOME);
});

after(async () => {
  if (environment) await local('down').catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true });
});

test('serves a signed-in site with a registered development Controller and keeps its identity across restarts', { timeout: 240_000 }, async () => {
  assert.match((await local('up', '--no-build')).stdout, /uplink registered/);
  const report = JSON.parse((await local('status', '--json')).stdout);
  assert.equal(report.state, 'running');
  assert.equal(report.localUser, true);
  assert.equal(report.controllerUplink, 'registered');
  assert.equal((await (await fetch(report.origin + '/auth/status')).json()).user.id, 'devbox');

  const hosts = JSON.parse((await local('api', 'v1/remote/hosts')).stdout).hosts;
  assert.deepEqual(hosts.map(host => [host.name, host.online]), [[`Dev · ${basename(source)}`, true]]);

  const image = join(root, 'page.png');
  await local('screenshot', '/', '--out', image, '--viewport', '800x600');
  assert.deepEqual([...(await readFile(image)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  await assert.rejects(local('controller', 'start'), /runner owns start/);
  await assert.rejects(local('remove', '--yes'), /pnpm local down first/);

  await local('down');
  assert.equal(processAlive(report.build.runnerPid), false);
  assert.equal(processAlive(report.build.controllerPid), false);
  assert.ok(existsSync(join(report.directory, 'relay', 'identity.json')));
  assert.ok(existsSync(join(report.directory, 'controller', 'connection.json')));

  await local('up', '--no-build');
  const restarted = JSON.parse((await local('status', '--json')).stdout);
  assert.equal(restarted.origin, report.origin);
  assert.equal(restarted.controllerUplink, 'registered');
  assert.equal(JSON.parse((await local('api', 'v1/remote/hosts')).stdout).hosts.length, 1);

  await local('down');
  await local('remove', '--yes');
  assert.equal(existsSync(report.directory), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=240000 scripts/local/command.test.mjs`
Expected: FAIL — `Command failed: ... scripts/local/command.mjs up --no-build` with `Cannot find module`.

- [ ] **Step 3: Implement `scripts/local/command.mjs`**

```javascript
import { execFile, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { controllerBuildProvenance } from '../lib/build-provenance.mjs';
import { packageManager } from '../lib/package-manager.mjs';
import { controllerEnvironment } from './environment.mjs';
import { findInstance, listInstances, portAvailable, prepareInstance, processAlive, processCommand, readJson, runState, withLock } from './instance.mjs';
import { screenshot, signedInUser, userApi } from './session.mjs';

const source = realpathSync(resolve(import.meta.dirname, '../..'));
const controllerCli = join(source, 'packages/agent-host/dist/cli.js');
const controllerCommands = new Set(['status', 'diagnostics', 'window', 'session', 'environment', 'help', '--help', '-h', '--version']);
const usage = `Usage: pnpm local <command>
  up [--no-build]        Build, then start or restart this checkout's instance
  down                   Stop this checkout's instance; its state is kept
  status [--json]        URL, running build, local user and Controller registration
  logs [--follow]        Runner and Controller output of the current run
  list [--json]          Every local instance on this machine
  remove --yes           Delete this checkout's stopped instance
  controller <args>      Controller CLI for this instance: status, diagnostics, window, session, environment
  api <v1/path> [--method M] [--data JSON]   Signed-in JSON request to the instance
  screenshot <path> --out FILE [--viewport WxH] [--wait-for CSS] [--full-page]
`;

async function requireInstance() {
  const instance = await findInstance(source);
  if (!instance) throw new Error('This checkout has no local instance. Run pnpm local up.');
  return instance;
}

async function requireRunning() {
  const instance = await requireInstance();
  if (await runState(instance.directory, await readJson(instance.runtimeFile)) !== 'running') {
    throw new Error('The instance is not running. Run pnpm local up.');
  }
  return instance;
}

async function runStep(command, args) {
  const [file, argv] = command === 'pnpm' ? packageManager('pnpm', args) : [command, args];
  const child = spawn(file, argv, { cwd: source, stdio: 'inherit' });
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  if (code !== 0) throw new Error(`Build step failed: ${[command, ...args].join(' ')}. A running instance was left unchanged.`);
}

async function build() {
  if (!existsSync(join(source, 'node_modules'))) await runStep('pnpm', ['install', '--frozen-lockfile']);
  await runStep('pnpm', ['--filter', '@orchardworks/agent-remote-controller...', 'run', 'build']);
  await runStep('pnpm', ['build:relay']);
  await runStep(process.execPath, [join(source, 'scripts/build-devbox.mjs')]);
}

function assertBuilt() {
  const web = process.env.ARC_LOCAL_WEB_DIST ?? join(source, 'dist/relay/web');
  const missing = [controllerCli, join(source, 'dist/devbox/server.mjs'), join(web, 'index.html')].filter(path => !existsSync(path));
  if (missing.length) throw new Error(`Build artifacts are missing (${missing.join(', ')}). Run pnpm local up without --no-build.`);
}

async function controllerUplink(instance) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [controllerCli, 'status'],
      { env: controllerEnvironment(process.env, instance), cwd: instance.workspace, timeout: 10_000, maxBuffer: 65536 });
    return /uplink: ([a-z_-]+)/.exec(stdout)?.[1];
  } catch { return undefined; }
}

async function logTails(instance, lines) {
  const parts = [];
  for (const name of ['runner.log', 'controller.log']) {
    const text = await readFile(join(instance.logs, name), 'utf8').catch(() => '');
    parts.push(`--- ${name} (last ${lines} lines) ---\n${text.trimEnd().split('\n').slice(-lines).join('\n')}`);
  }
  return parts.join('\n');
}

async function stopProcess(pid, marker, timeoutMs = 30_000) {
  if (!(await processCommand(pid))?.includes(marker)) return;
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`Runner pid ${pid} did not stop within ${timeoutMs / 1000} seconds.`);
    await delay(200);
  }
}

async function stopRunner(instance) {
  const runtime = await readJson(instance.runtimeFile);
  const state = await runState(instance.directory, runtime);
  if (state === 'orphaned') {
    throw new Error(`The runner is gone but Controller pid ${runtime.controllerPid} still runs. Stop that process, then retry.`);
  }
  if (state === 'running') await stopProcess(runtime.runnerPid, instance.directory);
  await rm(instance.runtimeFile, { force: true });
}

async function startRunner(instance) {
  const log = await open(join(instance.logs, 'runner.log'), 'w', 0o600);
  try {
    const child = spawn(process.execPath, [join(source, 'scripts/local/runner.mjs'), instance.directory],
      { cwd: instance.directory, env: process.env, stdio: ['ignore', log.fd, log.fd], detached: true });
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    child.unref();
    return child.pid;
  } finally { await log.close(); }
}

async function waitUntilReady(instance, runnerPid) {
  const timeoutMs = Number(process.env.ARC_LOCAL_READY_TIMEOUT_MS ?? 90_000);
  const deadline = Date.now() + timeoutMs;
  let waiting = 'the site';
  while (Date.now() < deadline) {
    if (!processAlive(runnerPid)) throw new Error('The runner exited during startup.');
    if (await signedInUser(instance.record.origin).catch(() => false)) {
      waiting = 'Controller registration';
      if (await controllerUplink(instance) === 'registered') return;
    }
    await delay(500);
  }
  throw new Error(`The instance did not become ready within ${timeoutMs / 1000} seconds while waiting for ${waiting}.`);
}

async function describe(instance) {
  const runtime = await readJson(instance.runtimeFile);
  const state = await runState(instance.directory, runtime);
  const running = state === 'running';
  const [localUser, uplink, checkout] = await Promise.all([
    running ? signedInUser(instance.record.origin).catch(() => false) : false,
    running ? controllerUplink(instance) : undefined,
    controllerBuildProvenance(instance.record.source, {}).catch(() => undefined),
  ]);
  return {
    name: instance.record.name, source: instance.record.source, directory: instance.directory, origin: instance.record.origin,
    state, localUser, controllerUplink: uplink ?? null,
    build: runtime ? { revision: runtime.revision, dirty: runtime.dirty, startedAt: runtime.startedAt, runnerPid: runtime.runnerPid, controllerPid: runtime.controllerPid } : null,
    checkout: checkout ?? null,
  };
}

const revision = value => value ? `${value.revision.slice(0, 12)}${value.dirty ? ' (dirty)' : ''}` : 'unknown';

async function printStatus(instance, json) {
  const report = await describe(instance);
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write([
    `Instance: ${report.name} (${report.state})`,
    `Site: ${report.origin}  local user: ${report.localUser ? 'signed in' : 'unavailable'}`,
    `Controller: ${report.controllerUplink ? `uplink ${report.controllerUplink}` : 'not running'}${report.build ? ` (pid ${report.build.controllerPid})` : ''}`,
    `Running build: ${report.build ? `${revision(report.build)} since ${report.build.startedAt}` : 'none'}; checkout now ${revision(report.checkout)}`,
    `State: ${report.directory}`,
  ].join('\n') + '\n');
  return report;
}

async function up(options) {
  const instance = await prepareInstance(source);
  await withLock(instance.directory, async () => {
    if (options['no-build']) assertBuilt();
    else await build();
    await stopRunner(instance);
    if (!(await portAvailable(instance.record.port))) {
      throw new Error(`Port ${instance.record.port} is in use by another process. The origin ${instance.record.origin} cannot change; free the port and run up again.`);
    }
    const runnerPid = await startRunner(instance);
    try { await waitUntilReady(instance, runnerPid); }
    catch (error) {
      await stopProcess(runnerPid, instance.directory).catch(() => undefined);
      throw new Error(`${error.message}\n${await logTails(instance, 20)}`);
    }
  });
  await printStatus(instance, false);
}

async function down() {
  const instance = await requireInstance();
  await withLock(instance.directory, () => stopRunner(instance));
  process.stdout.write(`Stopped ${instance.record.name}. Its state remains in ${instance.directory}.\n`);
}

async function status(options) {
  const instance = await findInstance(source);
  if (!instance) {
    process.stdout.write('This checkout has no local instance. Run pnpm local up.\n');
    process.exitCode = 3;
    return;
  }
  const report = await printStatus(instance, options.json);
  if (report.state !== 'running' || !report.localUser || report.controllerUplink !== 'registered') process.exitCode = 3;
}

async function logs(options) {
  const instance = await requireInstance();
  if (!options.follow) { process.stdout.write(await logTails(instance, 80) + '\n'); return; }
  const child = spawn('tail', ['-n', '40', '-F', join(instance.logs, 'runner.log'), join(instance.logs, 'controller.log')], { stdio: 'inherit' });
  await new Promise(resolveExit => child.once('exit', resolveExit));
}

async function list(options) {
  const current = (await findInstance(source))?.directory;
  const rows = [];
  for (const instance of await listInstances()) {
    rows.push({ name: instance.record.name, state: await runState(instance.directory, instance.runtime),
      origin: instance.record.origin, source: instance.record.source, current: instance.directory === current });
  }
  if (options.json) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  else if (!rows.length) process.stdout.write('No local instances.\n');
  else for (const row of rows) process.stdout.write(`${row.current ? '*' : ' '} ${row.name}  ${row.state}  ${row.origin}  ${row.source}\n`);
}

async function remove(options) {
  const instance = await requireInstance();
  if (!options.yes) throw new Error(`This deletes ${instance.directory}, including its site state and Controller pairing. Repeat with --yes.`);
  await withLock(instance.directory, async () => {
    const state = await runState(instance.directory, await readJson(instance.runtimeFile));
    if (state === 'running' || state === 'orphaned') throw new Error('Stop the instance with pnpm local down first.');
  });
  await rm(instance.directory, { recursive: true, force: true });
  process.stdout.write(`Removed ${instance.directory}. Test sessions remain in the shared native histories.\n`);
}

async function controller(args) {
  const instance = await requireInstance();
  if (!controllerCommands.has(args[0] ?? '')) {
    throw new Error('pnpm local controller runs status, diagnostics, window, session or environment. The runner owns start, stop, pairing and updates, and native subcommands could take over shared sessions.');
  }
  const child = spawn(process.execPath, [controllerCli, ...args], { env: controllerEnvironment(process.env, instance), cwd: instance.workspace, stdio: 'inherit' });
  process.exitCode = await new Promise(resolveExit => child.once('exit', code => resolveExit(code ?? 1)));
}

async function api(positionals, options) {
  const instance = await requireRunning();
  const [path] = positionals;
  if (!path) throw new Error('Name an API path, for example: pnpm local api v1/remote/hosts');
  if (options.data !== undefined) JSON.parse(options.data);
  const result = await userApi(instance.record.origin, path, { method: options.method ?? (options.data === undefined ? 'GET' : 'POST'), data: options.data });
  process.stdout.write(result.body.endsWith('\n') ? result.body : result.body + '\n');
  if (result.status >= 400) { process.stderr.write(`HTTP ${result.status}\n`); process.exitCode = 1; }
}

async function capture(positionals, options) {
  const instance = await requireRunning();
  if (!options.out) throw new Error('Choose an output file with --out FILE.png.');
  const output = resolve(process.env.INIT_CWD ?? process.cwd(), options.out);
  await screenshot({ source, origin: instance.record.origin, path: positionals[0] ?? '/', output,
    viewport: options.viewport, waitFor: options['wait-for'], fullPage: options['full-page'] });
  process.stdout.write(`Saved ${output}\n`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'controller') await controller(rest);
  else {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
      'no-build': { type: 'boolean' }, json: { type: 'boolean' }, follow: { type: 'boolean' }, yes: { type: 'boolean' },
      method: { type: 'string' }, data: { type: 'string' }, out: { type: 'string' }, viewport: { type: 'string' },
      'wait-for': { type: 'string' }, 'full-page': { type: 'boolean' },
    } });
    if (command === 'up') await up(values);
    else if (command === 'down') await down();
    else if (command === 'status') await status(values);
    else if (command === 'logs') await logs(values);
    else if (command === 'list') await list(values);
    else if (command === 'remove') await remove(values);
    else if (command === 'api') await api(positionals, values);
    else if (command === 'screenshot') await capture(positionals, values);
    else {
      process.stdout.write(usage);
      if (command && command !== 'help') process.exitCode = 1;
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
```

- [ ] **Step 4: Add the root scripts**

In `package.json` `scripts`, after `"dev": "node scripts/dev.mjs",` add:

```json
    "local": "node scripts/local/command.mjs",
```

and after `"test:setup": "node scripts/run-tests.mjs setup",` add:

```json
    "test:local-env": "node scripts/run-tests.mjs local-env",
```

- [ ] **Step 5: Register the suite in `scripts/run-tests.mjs`**

In the `commands` object, add after the `'devbox-server'` entry:

```javascript
  'local-env': ['exec', 'node', '--test', '--test-timeout=240000', '--test-concurrency=1', 'scripts/local/instance.test.mjs', 'scripts/local/environment.test.mjs', 'scripts/local/session.test.mjs', 'scripts/local/runner.test.mjs', 'scripts/local/command.test.mjs'],
```

Append the same five files to the end of the `setup` array (after `'scripts/controller/install.test.mjs'`). In `outerDeadlineMs`, add `mode === 'local-env' ? 300_000 :` right after `mode === 'devbox-server' ? 80_000 :`.

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `node --test --test-timeout=240000 scripts/local/command.test.mjs`
Expected: PASS, 1 test, in under two minutes. If it times out waiting for Controller registration, read the temporary instance's `logs/controller.log` (path in the error) before changing code.

- [ ] **Step 7: Run the whole suite through the root runner**

Run: `pnpm test:local-env`
Expected: PASS, 16 tests, exit 0.

- [ ] **Step 8: Commit**

```bash
git add scripts/local/command.mjs scripts/local/command.test.mjs package.json scripts/run-tests.mjs
git commit -m "feat(local): manage per-checkout local instances with pnpm local

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Human guide and entry points

**Files:**
- Create: `docs/local-development.md`
- Modify: `README.md:736` (section "Run locally")
- Modify: `AGENTS.md:12`

- [ ] **Step 1: Write `docs/local-development.md`**

````markdown
# Local development instance

`pnpm local` runs the complete product from a source checkout on macOS: the
website and Relay with a built-in local user, and a development Controller
paired with them. Use it to see website, Relay and Controller changes working
before you push or deploy. Agents use it through the
[`prepare-arc-local` skill](../.agents/skills/prepare-arc-local/SKILL.md).

It reuses the [Devbox](devbox.md) server — the same automatic local sign-in and
Controller pairing — without Docker. The Docker Devbox remains the isolated
Linux alternative.

## Commands

Run from the checkout or worktree you want to try:

```bash
pnpm local up            # build, then start or restart this checkout's instance
pnpm local status        # URL, running build, local user and Controller state
pnpm local logs          # site and Controller output of the current run
pnpm local down          # stop; state is kept
pnpm local list          # every instance on this machine
pnpm local remove --yes  # delete this checkout's stopped instance
```

`pnpm local controller status|diagnostics|window|session|environment` runs the
Controller CLI against the instance. `pnpm local api v1/remote/hosts` reads the
signed-in API. `pnpm local screenshot / --out page.png` saves a headless
screenshot. Open the printed `http://localhost:<port>` URL in any local browser;
it is signed in automatically.

## How it works

Each checkout has one instance, named after the checkout directory and a hash
of its path:

```
~/.agent-remote-control-dev/instances/<checkout>-<hash>/
  instance.json   checkout path, port and origin
  runtime.json    current run: checkout commit and dirty flag at start, runner and Controller PIDs
  relay/          site state and local identity
  controller/     development Controller state, including its pairing
  workspace/      the Controller's only allowed workspace
  logs/           runner and Controller output of the current run
```

`up` builds the Controller, the website and the Devbox server bundle, then
starts a detached runner. The runner serves the site on
`http://localhost:<port>` and starts `packages/agent-host/dist/cli.js foreground`
from the same checkout with its own state directory. The first start pairs it
through the local identity; later starts reuse its device credential. The port
is chosen on the first start and kept, because the local identity is bound to
the origin.

Nothing is installed as a login service and nothing survives a reboot. Your own
Controller, its state and its launchd service are not touched.
`ARC_LOCAL_ROOT` moves the instance root; the tests use it with a temporary
directory.

## Shared native profiles

The development Controller uses the same `~/.claude`, `~/.codex` and other
native profiles as your own Controller, so no extra sign-in is needed. Its
environment is explicit: the launching shell's `AGENT_*`, `CLAUDECODE` and
similar variables are not passed on, and trusted full control is explicitly
disabled.

| Shared | Effect |
| --- | --- |
| Native sessions | The Controller only lists, creates and opens sessions inside the instance workspace and locks permission settings. Claude Code also runs in its restricted sandbox; Codex and Copilot sessions run with their own permissions, so only their working directory is checked. Test sessions are stored in the native histories and also appear in your own Controller. |
| Session ownership | Recorded in the profile (`.arc-session-owners`), so both Controllers see which one owns a session. |
| Codex daemon, OpenCode server | Never started, restarted or updated by the instance (`AGENT_HOST_CODEX_AUTO_START=0`, `AGENT_HOST_OPENCODE_AUTO_START=0`). Codex sessions use your running Codex daemon; without it, Codex is unavailable. OpenCode may be unavailable, because its server credentials belong to your own Controller's state. |
| Per-session stores | Permission modes and references under `~/.agent-remote-control/session-*` are keyed by session, so test sessions add entries there. |

In the instance website, do not use Controller update, Codex daemon restart,
OpenCode server or VS Code tunnel controls. Controller update would replace
this checkout's build; the other controls act on processes your own Controller
also uses. Claude Code and Codex are covered end to end; OpenCode Ask callbacks
go through the shared server.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Port … is in use by another process` | Another program took the instance's port. Free it; the origin cannot change. |
| `The runner exited during startup` | `pnpm local logs`. With `--no-build`, build artifacts may be missing. |
| The Controller never registers | `pnpm local controller diagnostics --source controller --limit 60`. |
| `orphaned` in `status` | The runner died while its Controller kept running. Stop that Controller (`ps -ww -o command= -p PID` shows `…/packages/agent-host/dist/cli.js foreground`), then `up`. |
| A provider is missing | It is not installed or detected on this Mac, or Codex has no running daemon. |

`pnpm test:local-env` runs the launcher's unit and integration tests with a
temporary home and instance root.
````

- [ ] **Step 2: Link it from the README**

In `README.md`, after line 736 (`Use Node 22 or later and pnpm 10.34.5. All commands run from this repository root.`) insert a blank line and:

```markdown
To try the complete product from a checkout or worktree on macOS — signed in
automatically, with a development Controller that uses your installed agents —
run `pnpm local up`. See [local development](docs/local-development.md).
```

- [ ] **Step 3: Point agents at the skill**

In `AGENTS.md`, after line 12 (`- Preserve existing local services and untracked user material. Use configurable free ports for local validation.`) insert:

```markdown
- Verify website, Relay and Controller changes in this checkout's local instance (`pnpm local up`); follow `.agents/skills/prepare-arc-local/SKILL.md`.
```

- [ ] **Step 4: Check the docs**

Run: `pnpm lint:docs`
Expected: exit 0 (the new guide has no Mermaid blocks; this confirms nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add docs/local-development.md README.md AGENTS.md
git commit -m "docs: describe the native local instance

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: The `prepare-arc-local` skill

**Files:**
- Create: `.agents/skills/prepare-arc-local/SKILL.md`
- Create: `.agents/skills/prepare-arc-local/references/lifecycle.md`
- Create: `.agents/skills/prepare-arc-local/references/verification.md`
- Create: `.agents/skills/prepare-arc-local/references/browser.md`
- Create: `.agents/skills/prepare-arc-local/references/api.md`
- Create: `.agents/skills/prepare-arc-local/references/test-loop.md`
- Create: `.claude/skills` (symlink to `../.agents/skills`)

- [ ] **Step 1: Write `SKILL.md`**

````markdown
---
name: prepare-arc-local
description: Use when verifying Agent Remote Control website, Relay or Controller changes in a local instance — preparing, refreshing or inspecting the per-checkout `pnpm local` environment, driving its signed-in site with a headless browser, reading its API, or running a real session through its development Controller. Excludes releases, Worker deployment and the user's own Controller.
---

# Prepare and operate the local instance

`pnpm local` runs this checkout's complete product on macOS: the website and
Relay with a built-in local user (no sign-in) and a development Controller
paired to it. Each checkout or worktree has its own instance, port and state
under `~/.agent-remote-control-dev/instances/`. The
[local development guide](../../../docs/local-development.md) owns the
mechanism; this skill says how to use it safely and what counts as evidence.

## Choose the reference

| Purpose | Read |
| --- | --- |
| Start, refresh, stop, inspect or clean up an instance | [lifecycle](references/lifecycle.md) |
| Decide what has been verified and report it | [verification](references/verification.md) |
| Look at or operate the website | [browser](references/browser.md) |
| Read state or prepare fixtures through the API | [api](references/api.md) |
| Run a real session end to end | [test loop](references/test-loop.md) |

Run every command from the checkout whose code you are verifying. An instance
runs the build it was started with; `pnpm local status` shows that build next
to the checkout's current commit. Rebuild with `pnpm local up` after changing
code. A check against an older build is not a check of your change.

## Hard rules

The development Controller shares `~/.claude`, `~/.codex` and the other native
profiles with the user's own Controller. Its workspace policy blocks sessions
outside the instance workspace, and Claude Code runs sandboxed there, but Codex
and Copilot sessions run with their own permissions; these rules still apply:

1. Operate only sessions you created in the instance workspace. Never take over,
   stop, archive or rename any other session, in the instance or elsewhere.
2. Never touch the user's own Controller — `~/.agent-remote-control/agents-cloud-cli`,
   its launchd service, the global `agent-remote-controller` command — or the
   production site. Operate the instance only through `pnpm local`.
3. Never use the instance website's Controller update, Codex daemon restart,
   OpenCode server or VS Code tunnel controls. Controller update would replace
   this checkout's build; the others act on processes shared with the user's
   Controller.
4. Never use the user's own browsers, profiles or windows. Use a headless browser
   as described in [browser](references/browser.md).
5. Never print cookies, pairing keys, `controller/connection.json` or whole
   configuration files.
6. Run `down` and `remove` only for the current checkout's instance. Other rows in
   `pnpm local list` may belong to other agents.
7. Run `pnpm local down` before removing a worktree.
8. A sandboxed session can be refused listening sockets or detached processes.
   Report the refusal and say that the session needs YOLO mode; do not work
   around the sandbox.

## Report

State the instance origin, the running build's commit and dirty state, and for
each [verification layer](references/verification.md) whether it was verified,
failed or not exercised, with the observation. Leave the instance running when
the user may want to look at it, and say so; otherwise stop it.
````

- [ ] **Step 2: Write `references/lifecycle.md`**

````markdown
# Instance lifecycle

Run all commands from the checkout being verified.

| Command | Use |
| --- | --- |
| `pnpm local up` | Build this checkout, then start or restart its instance. Prints status when ready. |
| `pnpm local up --no-build` | Restart with the existing build artifacts. |
| `pnpm local status [--json]` | State, URL, local user, Controller uplink, running build and checkout commit. Exit 0 only when ready. |
| `pnpm local logs [--follow]` | Runner (site) and Controller output of the current run. |
| `pnpm local controller diagnostics --source controller --limit 60` | Controller diagnostics with secrets redacted. |
| `pnpm local list [--json]` | Every instance on this machine; `*` marks this checkout. |
| `pnpm local down` | Stop this checkout's instance; state is kept. |
| `pnpm local remove --yes` | Delete this checkout's stopped instance. |

## Start and refresh

`up` builds with `pnpm --filter @orchardworks/agent-remote-controller... run build`,
`pnpm build:relay` and `scripts/build-devbox.mjs`, installing dependencies first
in a fresh worktree. A failed build leaves a running instance as it was. The
first `up` chooses a free port and keeps it: the local identity is bound to the
instance origin. If another process later takes that port, `up` stops with an
error; free the port instead of trying to change it.

Restarting interrupts the instance's running sessions. Their native history
persists, but active turns and pending approvals are not restored.

## When `up` fails

`up` prints the last lines of both logs. Typical causes:

| Symptom | Check |
| --- | --- |
| A build step failed | Fix the build; the old instance still runs its old build. |
| `The runner exited during startup` | `pnpm local logs`; often missing artifacts after `--no-build`. |
| Waiting for Controller registration | `pnpm local controller diagnostics --source controller --limit 60`. |
| `listen EPERM` or spawn errors | The session is sandboxed; report it and ask for YOLO mode. |
| `orphaned` state | The runner died but its Controller still runs. Confirm with `ps -ww -o command= -p PID` that the PID runs `packages/agent-host/dist/cli.js foreground` from this checkout, stop it, then run `up`. |

## Clean up

Stop instances you no longer need with `pnpm local down`, and always before
removing a worktree. `remove --yes` deletes the instance directory, including
its site state and pairing. Test sessions stay in the shared native histories
under paths inside `~/.agent-remote-control-dev`; the user's own Controller can
list them like any other session.
````

- [ ] **Step 3: Write `references/verification.md`**

````markdown
# Verification layers

Report each layer as verified, failed or not exercised, with what you observed.
A lower layer passing says nothing about a higher one.

| Layer | Evidence |
| --- | --- |
| Build | `pnpm local status` shows a running build commit equal to the checkout commit you changed, and its dirty state. |
| Site | `status` reports `running` and `local user: signed in`. |
| Controller | `status` reports `uplink registered`; `pnpm local api v1/remote/hosts` lists `Dev · <checkout>` with `"online": true` and the expected providers. |
| Page | A headless screenshot of the signed-in page taken after the change, showing the changed UI. See [browser](browser.md). |
| Feature | The changed behaviour exercised through real page controls, with screenshots of each state the conclusion rests on. |
| Model turn | A session created in the instance workspace completes a real reply. See [test loop](test-loop.md). |

An HTTP response, a screenshot or a registered Controller is not evidence that
a model turn works. An API write is not evidence that a page control works.

Claude Code and Codex are covered end to end. OpenCode and Copilot can appear,
but their shared server and callbacks belong to the user's Controller; report
their results as partial.

If a layer cannot run — no provider access, a sandbox refusal, no running Codex
daemon — say which layer and why instead of substituting a weaker check.
````

- [ ] **Step 4: Write `references/browser.md`**

````markdown
# Operating the website headlessly

The instance signs any local browser in as its local user on the first request.
Use the repository's Playwright with its bundled Chromium, headless, in a new
browser context. Never attach to or open the user's own browsers.

## Quick screenshot

```bash
pnpm local screenshot / --out .tmp/local/home.png
pnpm local screenshot / --out .tmp/local/phone.png --viewport 390x844
pnpm local screenshot '/?host=HOST&provider=claude&session=ID' --out .tmp/local/session.png --full-page
```

The command waits for the signed-in product shell (`main.lab-shell`), or for
`--wait-for CSS`, then half a second more, and saves the image. Relative output
paths are resolved from where you ran pnpm. Keep evidence under the checkout's
ignored `.tmp/`.

## Scripted interaction

For clicks, typing and assertions, write a short script under the checkout's
`.tmp/local/` and run it with `node` from the checkout root. Resolve Playwright
from the Lab package:

```javascript
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = process.cwd();
const { origin } = JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' }));
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');
const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(origin + '/');
  await page.locator('main.lab-shell').waitFor({ timeout: 30_000 });
  // Act through what the user sees, for example:
  // await page.getByRole('button', { name: 'New session' }).click();
  await page.screenshot({ path: '.tmp/local/step-1.png' });
} finally {
  await browser.close();
}
```

`status --json` exits 3 when the instance is not ready, which makes
`execFileSync` throw; start the instance first. Prefer `getByRole`, `getByLabel`
and visible text over CSS classes, and wait for the expected control or text
instead of fixed sleeps. Every new browser context is a fresh sign-in of the
same local user: Windows and other per-user state persist across contexts,
browser storage does not.

If page code fails only in automation, read the console (`page.on('console', …)`)
and network before calling it a product defect.
````

- [ ] **Step 5: Write `references/api.md`**

````markdown
# Reading the instance through its API

`pnpm local api <path>` signs in as the local user, calls `/u/<user>/<path>` on
the instance and signs out again. It prints the response body; a status of 400
or more is also written to stderr and exits 1.

```bash
pnpm local api v1/remote/hosts
```

Use it to read state the website reads: Hosts and their providers, and other
`v1/` resources. Find a resource's path in the page's network requests or in
`packages/agent-remote-hosted/src/`.

Writes (`--method POST --data '{...}'`) are acceptable only to prepare fixtures
for a check that then uses the page — for example creating several items before
testing how the page lists them. An API write never counts as verifying the page
control that performs the same action. Create and change only resources your
test created.
````

- [ ] **Step 6: Write `references/test-loop.md`**

````markdown
# Real session test loop

Use this when a change affects sessions, or when asked for a complete local test.

1. `pnpm local up`, then `pnpm local status`. Continue only when the running build
   equals your checkout commit, the local user is signed in and the Controller is
   registered.
2. `pnpm local api v1/remote/hosts`: the `Dev · <checkout>` Host is online and lists
   the provider you will test (Claude Code or Codex). A missing provider means it
   is not installed or detected on this Mac; report that.
3. In a headless browser (see [browser](browser.md)), open the site, select the
   `Dev · <checkout>` Host and the provider, and create a new session. The
   instance workspace (`~/.agent-remote-control-dev/instances/<name>/workspace`)
   is the only workspace the Controller offers; add files there only when the
   test needs them.
4. Send a short prompt with a recognisable answer, such as
   `Reply with the word LOCAL-OK and nothing else.` Wait for the reply in the page
   with a bounded wait of two minutes and take a screenshot.
5. Exercise the behaviour under change through the page controls — Window, Side,
   Team, references and so on — and take a screenshot of each state your
   conclusion rests on.
6. Report per [verification](verification.md). Leave your session idle; do not
   archive or remove sessions you did not create.

Provider sign-in and model access come from the shared native profile. A failed
turn caused by provider access is a provider result, not an instance failure;
report it as such.
````

- [ ] **Step 7: Link the skills for Claude Code**

```bash
mkdir -p .claude
ln -s ../.agents/skills .claude/skills
ls .claude/skills/prepare-arc-local/SKILL.md
```

Expected: the `ls` prints the path (the link resolves).

- [ ] **Step 8: Commit**

```bash
git add .agents/skills/prepare-arc-local .claude/skills
git commit -m "feat(skills): teach agents to prepare and operate the local instance

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Compatibility, full checks and manual acceptance

**Files:** possibly `**/compatibility.json` (generated)

- [ ] **Step 1: Update and check compatibility metadata**

```bash
pnpm compatibility:update
git status --short
pnpm compatibility:check
```

Expected: `compatibility:check` exits 0. Commit any changed `compatibility.json` files:

```bash
git add -A '*compatibility.json'
git commit -m "chore: update compatibility metadata

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Skip the commit if `git status` showed no change.

- [ ] **Step 2: Run the launcher suites**

```bash
pnpm test:local-env
pnpm test:setup
pnpm test:devbox
```

Expected: all exit 0. `test:devbox` confirms the shared Devbox code is unchanged in behaviour.

- [ ] **Step 3: Manual acceptance with the real shared profiles**

This step uses the real HOME and must run in a shell without the Claude Code sandbox (YOLO), because it listens on a port and starts detached processes. From the worktree:

```bash
pnpm local up
pnpm local status
pnpm local api v1/remote/hosts
mkdir -p .tmp/local && pnpm local screenshot / --out .tmp/local/home.png
```

Expected: status reports `running`, `local user: signed in`, `uplink registered` and a running build equal to `git rev-parse HEAD`; the Hosts list contains `Dev · local-dev-env` online with Claude Code (and Codex if its daemon runs); the screenshot shows the signed-in product. Read the image to confirm.

Then follow `.agents/skills/prepare-arc-local/references/test-loop.md` steps 3–4 with Claude Code: a session in the instance workspace answers `LOCAL-OK`. Confirm the policy boundary: in the instance website, the session list shows no sessions from other directories. Confirm the user's own Controller is unaffected:

```bash
agent-remote-controller status
```

Expected: still `uplink: registered` (read-only status call; do not run any other command against it).

Finish with `pnpm local down` and confirm `pnpm local status` reports `stopped`.

- [ ] **Step 4: Report**

Report to the user: commits on `feat/local-dev-env`, test results, each acceptance observation and anything not exercised. Do not push or merge.
