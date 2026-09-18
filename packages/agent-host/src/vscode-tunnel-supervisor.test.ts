import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { vscodeTunnelSupervisorSource } from './vscode-tunnel-supervisor.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

test.each(['SIGTERM', 'SIGKILL'] as const)('reclaims a stubborn tunnel and its descendants when the Controller receives %s', async signal => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-vscode-orphan-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const pidsPath = join(directory, 'pids.json');
  const tunnel = join(directory, 'tunnel.cjs');
  await writeFile(tunnel, `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    require('node:fs').writeFileSync(${JSON.stringify(pidsPath)},JSON.stringify({tunnel:process.pid,descendant:child.pid}));
    process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
  `);
  const config = { executable: process.execPath, args: [tunnel], cwd: directory, stopTimeoutMs: 100 };
  const controller = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const supervisor=spawn(process.execPath,['-e',${JSON.stringify(vscodeTunnelSupervisorSource)},${JSON.stringify(JSON.stringify(config))}],
      {stdio:['pipe','ignore','ignore','ipc'],detached:true});
    require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'supervisor'))},String(supervisor.pid));
    setInterval(()=>{},1000);
  `], { stdio: 'ignore' });
  let pids: { tunnel: number; descendant: number } | undefined;
  let supervisorPid: number | undefined;
  cleanup.push(async () => {
    for (const pid of [controller.pid, supervisorPid, pids?.tunnel, pids?.descendant]) {
      if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  });
  await expect.poll(async () => {
    try { pids = JSON.parse(await readFile(pidsPath, 'utf8')); supervisorPid = Number(await readFile(join(directory, 'supervisor'), 'utf8')); return true; } catch { return false; }
  }).toBe(true);
  controller.kill(signal);
  await expect.poll(() => [controller.pid!, supervisorPid!, pids!.tunnel, pids!.descendant].filter(alive), { timeout: 5000 }).toEqual([]);
});
