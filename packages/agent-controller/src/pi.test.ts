import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPiHostRegistration } from './pi.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function entry(source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-host-')); temporary.push(directory);
  const path = join(directory, 'pi.mjs');
  await writeFile(path, source, { mode: 0o700 });
  return path;
}

describe('pi registration executable preflight', () => {
  it('runs the CLI entry with the selected profile before advertising', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-profile-')); temporary.push(directory);
    const piHome = join(directory, 'agent'); await mkdir(piHome);
    const executable = await entry(`if (process.argv[2] !== '--version' || process.env.PI_CODING_AGENT_DIR !== ${JSON.stringify(piHome)} || process.env.PI_HOST_TEST !== 'yes') process.exit(1); console.log('0.73.1');`);
    const registration = await createPiHostRegistration({ executable, piHome, env: { PI_HOST_TEST: 'yes' }, referenceDirectory: join(directory, 'refs'), permissionModeDirectory: join(directory, 'modes'), workspaces: [{ id: 'work', name: 'Work', path: '/work' }] });
    try {
      expect(registration.adapter.descriptor.providerId).toBe('pi');
      expect(registration.directory.providerId).toBe('pi');
      expect(registration.nativeVersion).toBe('0.73.1');
      expect(registration.nativePermissionControl).toBe(true);
      expect(await registration.directory.workspaces()).toEqual([{ id: 'work', name: 'Work', path: '/work' }]);
    } finally { await registration.directory.close(); }
  });
  it.each(['0.73.0', '0.60.2', 'GitHub Copilot CLI 1.0.83', ''])('rejects an old or foreign version output: %s', async output => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-profile-')); temporary.push(directory);
    await expect(createPiHostRegistration({ executable: await entry(`console.log(${JSON.stringify(output)});`), piHome: directory, referenceDirectory: join(directory, 'refs'), permissionModeDirectory: join(directory, 'modes') })).rejects.toThrow(/pi/);
  });
  it('rejects a missing executable', async () => {
    await expect(createPiHostRegistration({ executable: '/nonexistent/pi' })).rejects.toThrow(/not an executable file/);
  });
});
