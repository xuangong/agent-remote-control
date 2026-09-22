import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createWindowsAutostart } from './platform/services/windows.js';

it.runIf(process.platform === 'win32')('runs the installed login launcher with literal paths and saved environment, then removes it on disable', async () => {
  const home = await mkdtemp(join(tmpdir(), "arc login & %literal% ' "));
  try {
    const stateDir = join(home, 'state'); const startupDirectory = join(home, 'startup');
    await mkdir(stateDir);
    const cliPath = join(home, 'controller.cjs');
    const capture = join(home, 'capture.json');
    await writeFile(cliPath, `require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({
      args:process.argv.slice(2),cwd:process.cwd(),state:process.env.AGENT_HOST_STATE_DIR,
      supervisor:process.env.AGENT_HOST_SUPERVISOR,key:process.env.AGENT_HOST_REMOTE_KEY}));`);
    const service = createWindowsAutostart({ stateDir, home, startupDirectory, cwd: home,
      nodePath: process.execPath, cliPath, path: process.env.PATH ?? '' });
    await service.install();
    const installed = await service.status();
    expect(installed).toMatchObject({ enabled: true, installed: true, loaded: false });
    await promisify(execFile)('wscript.exe', ['//B', '//Nologo', installed.startupFile], {
      env: { ...process.env, AGENT_HOST_REMOTE_KEY: 'must-not-forward' }, timeout: 5000, windowsHide: true,
    });
    await expect.poll(async () => JSON.parse(await readFile(capture, 'utf8')), { timeout: 10000 }).toEqual({
      args: ['_login'], cwd: home, state: stateDir, supervisor: 'windows',
    });
    await service.disable();
    expect(await service.status()).toMatchObject({ enabled: false, installed: false, loaded: false });
    await expect(stat(installed.startupFile)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}, 15000);
