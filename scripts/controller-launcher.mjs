#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, mkdir, rename, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const launcher = fileURLToPath(import.meta.url);
const state = resolve(process.env.AGENT_HOST_STATE_DIR ?? join(homedir(), '.agent-remote-control/agent-host'));
const updates = join(state, 'controller-updates');
const base = join(dirname(launcher), 'cli.js');
const args = process.argv.slice(2);
const service = ['_serve', 'foreground'].includes(args[0]);
const versionPattern = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const cliFor = version => join(updates, 'packages', version, 'node_modules/@orchardworks/agent-remote-controller/dist/cli.js');
async function read(name) { try { return JSON.parse(await readFile(join(updates, name), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
async function save(name, value) { await mkdir(updates, { recursive: true, mode: 0o700 }); const path = join(updates, name), temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, path); }
let current = base;
const saved = await read('current.json');
if (saved && versionPattern.test(saved.version)) {
  try { current = cliFor(saved.version); await access(current); }
  catch { current = base; if (service) await status('failed', 'The saved Controller package is unavailable. The bootstrap version was restored.'); }
}
let child, stopping = false, candidate, previous, timer;
async function status(phase, message) {
  const old = await read('status.json');
  await save('status.json', { ...old, phase, ...(message ? { message } : { message: undefined }), updatedAt: Date.now() });
}
function stop(signal) { if (stopping) return; stopping = true; clearTimeout(timer); child?.kill(signal);
  const deadline = setTimeout(() => { child?.kill('SIGKILL'); }, 15000); deadline.unref(); }
process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
function start(cli) {
  child = spawn(process.execPath, [cli, ...args], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
    env: { ...process.env, AGENT_HOST_LAUNCHER: launcher, AGENT_HOST_LAUNCHER_PID: String(process.pid), AGENT_HOST_MANAGED_UPDATES: '1' } });
  const running = child;
  running.on('message', message => { void (async () => {
    if (stopping || !service || running !== child) return;
    if (message?.type === 'controller-update' && !candidate && versionPattern.test(message.version)) {
      const target = cliFor(message.version); await access(target);
      previous = current; candidate = { cli: target, version: message.version, started: false };
      await status('restarting'); running.send({ type: 'controller-update-accepted', version: message.version }); running.kill('SIGTERM');
      timer = setTimeout(() => running.kill('SIGKILL'), 15000);
    } else if (message?.type === 'controller-ready' && candidate?.started) {
      if (message.version !== candidate.version) throw new Error('Updated Controller reported the wrong version.');
      clearTimeout(timer);
      await save('current.json', { version: candidate.version });
      current = candidate.cli; candidate = undefined;
      await status('succeeded');
    }
  })().catch(async error => { console.error('Controller update:', error.message); await status('failed', 'Controller update could not be activated.'); if (candidate?.started) running.kill('SIGTERM'); else { candidate = undefined; running.send({ type: 'controller-update-rejected', version: message?.version }); } }); });
  running.once('error', error => { console.error(error.message); });
  running.once('exit', (code, signal) => { void (async () => {
    clearTimeout(timer);
    if (stopping) { process.exitCode = code ?? 0; return; }
    if (candidate && !candidate.started) {
      candidate.started = true; start(candidate.cli);
      timer = setTimeout(() => { child?.kill('SIGKILL'); }, 60000); return;
    }
    if (candidate?.started) {
      candidate = undefined; current = previous;
      await status('failed', 'The new Controller did not register. The previous version was restored.');
      start(current); return;
    }
    process.exitCode = code ?? (signal ? 1 : 0);
  })().catch(error => { console.error(error.message); process.exitCode = 1; }); });
}
if (service && (await read('status.json'))?.phase === 'restarting') {
  await status('failed', 'The update was interrupted. The saved Controller version is being restored; retry after reconnecting.');
}
start(current);
