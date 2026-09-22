#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, mkdir, rename, writeFile, access, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
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
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try { await rename(temp, path); break; }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 7 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
// Keep a durable reinstall journal so a host restart between uninstall and
// activation restores the previous runtime before serving any work.
const packageFor = version => join(updates, 'packages', version);
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function restoreClean() {
  const journal = await read('reinstall.json');
  if (!journal) return;
  if (!versionPattern.test(journal.version) || (journal.savedVersion && !versionPattern.test(journal.savedVersion))) throw Error('Invalid reinstall recovery journal.');
  const target = packageFor(journal.version), backup = target + '.clean-backup';
  if (await exists(backup)) { await rm(target, { recursive: true, force: true }); await rename(backup, target); }
  else if (!journal.hadTarget) await rm(target, { recursive: true, force: true });
  if (journal.savedVersion && journal.savedVersion !== journal.version) {
    const prior = packageFor(journal.savedVersion), priorBackup = prior + '.clean-backup';
    if (await exists(priorBackup)) { await rm(prior, { recursive: true, force: true }); await rename(priorBackup, prior); }
  }
  if (journal.savedVersion) await save('current.json', { version: journal.savedVersion });
  else await rm(join(updates, 'current.json'), { force: true });
  await rm(join(updates, 'reinstall.json'));
}
async function prepareClean(version) {
  const target = packageFor(version), backup = target + '.clean-backup';
  if (await read('reinstall.json')) throw Error('A prior reinstall journal needs recovery.');
  // A backup without a journal is from a committed reinstall whose cleanup was
  // interrupted. It is no longer the rollback target and can be removed safely.
  await rm(backup, { recursive: true, force: true });
  const prior = await read('current.json');
  if (prior?.version && !versionPattern.test(prior.version)) throw Error('Invalid saved Controller version.');
  if (prior?.version && prior.version !== version) await rm(packageFor(prior.version) + '.clean-backup', { recursive: true, force: true });
  await save('reinstall.json', { version, hadTarget: await exists(target), savedVersion: prior?.version });
  if (prior?.version && prior.version !== version && await exists(packageFor(prior.version))) await rename(packageFor(prior.version), packageFor(prior.version) + '.clean-backup');
  if (await exists(target)) await rename(target, backup);
  await rename(target + '.reinstall', target);
}
if (service && await read('reinstall.json')) {
  await restoreClean();
  await status('failed', 'Clean install was interrupted. The previous Controller was restored.');
}
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
function shutdown(running, signal = 'SIGTERM') {
  if (!running || running.exitCode !== null || running.signalCode !== null) return;
  if (process.platform === 'win32' && running.connected) {
    running.send({ type: 'controller-shutdown' }, () => {});
  } else running.kill(signal);
}
function stop(signal) { if (stopping) return; stopping = true; clearTimeout(timer); shutdown(child, signal);
  const deadline = setTimeout(() => { child?.kill('SIGKILL'); }, 15000); deadline.unref(); }
process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
if (process.connected) {
  process.on('message', message => { if (message?.type === 'controller-shutdown') stop('SIGTERM'); });
  process.once('disconnect', () => stop('SIGTERM'));
}
function start(cli) {
  child = spawn(process.execPath, [cli, ...args], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
    env: { ...process.env, AGENT_HOST_LAUNCHER: launcher, AGENT_HOST_LAUNCHER_PID: String(process.pid), AGENT_HOST_MANAGED_UPDATES: '1', AGENT_HOST_CLEAN_INSTALL: '1' } });
  const running = child;
  running.on('message', message => { void (async () => {
    if (stopping || !service || running !== child) return;
    if (message?.type === 'controller-ready') {
      // Readiness follows durable enrollment. Future children must use the saved
      // device credential, never replay the one-time invitation from bootstrap.
      delete process.env.AGENT_HOST_REMOTE_KEY;
      delete process.env.AGENT_HOST_SERVER;
    }
    if (message?.type === 'controller-update' && !candidate && versionPattern.test(message.version)) {
      const target = cliFor(message.version);
      await access(message.clean === true ? join(packageFor(message.version) + '.reinstall', 'node_modules/@orchardworks/agent-remote-controller/dist/cli.js') : target);
      previous = current; candidate = { cli: target, version: message.version, clean: message.clean === true, started: false };
      await status('restarting'); running.send({ type: 'controller-update-accepted', version: message.version }); shutdown(running);
      timer = setTimeout(() => running.kill('SIGKILL'), 15000);
    } else if (message?.type === 'controller-ready' && candidate?.started) {
      if (message.version !== candidate.version) throw new Error('Updated Controller reported the wrong version.');
      clearTimeout(timer);
      await save('current.json', { version: candidate.version });
      const completed = candidate;
      if (completed.clean) await rm(join(updates, 'reinstall.json'), { force: true });
      current = candidate.cli; candidate = undefined;
      await status('succeeded');
      if (completed.clean) {
        try {
          await rm(packageFor(completed.version) + '.clean-backup', { recursive: true, force: true });
          // Preserve the bootstrap launcher and remove only the superseded managed runtime.
          const prefix = join(updates, 'packages') + sep;
          if (previous !== current && previous.startsWith(prefix)) {
            const oldVersion = previous.slice(prefix.length).split(sep)[0];
            if (versionPattern.test(oldVersion)) await rm(packageFor(oldVersion) + '.clean-backup', { recursive: true, force: true });
          }
        } catch { console.error('Clean install completed; an inactive runtime backup could not be removed.'); }
      }
    }
  })().catch(async error => { console.error('Controller update:', error.message); await status('failed', 'Controller update could not be activated.'); if (candidate?.started) shutdown(running); else { candidate = undefined; running.send({ type: 'controller-update-rejected', version: message?.version }); } }); });
  running.once('error', error => { console.error(error.message); });
  running.once('exit', (code, signal) => { void (async () => {
    clearTimeout(timer);
    if (stopping) { process.exitCode = code ?? 0; if (process.connected) process.disconnect(); return; }
    if (candidate && !candidate.started) {
      if (candidate.clean) {
        try { await prepareClean(candidate.version); }
        catch (error) {
          await restoreClean(); candidate = undefined; current = previous;
          await status('failed', 'Clean install could not replace the runtime. The previous Controller was restored.');
          start(current); return;
        }
      }
      candidate.started = true; start(candidate.cli);
      timer = setTimeout(() => { child?.kill('SIGKILL'); }, 60000); return;
    }
    if (candidate?.started) {
      if (candidate.clean) await restoreClean();
      candidate = undefined; current = previous;
      await status('failed', 'The new Controller did not register. The previous version was restored.');
      start(current); return;
    }
    process.exitCode = code ?? (signal ? 1 : 0);
    if (process.connected) process.disconnect();
  })().catch(error => { console.error(error.message); process.exitCode = 1; }); });
}
if (service && (await read('status.json'))?.phase === 'restarting') {
  await status('failed', 'The update was interrupted. The saved Controller version is being restored; retry after reconnecting.');
}
start(current);
