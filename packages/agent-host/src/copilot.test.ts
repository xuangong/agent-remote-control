import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCopilotHostRegistration } from './copilot.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function entry(source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-host-')); temporary.push(directory);
  const path = join(directory, 'copilot.mjs');
  await writeFile(path, source, { mode: 0o600 });
  return path;
}

describe('Copilot registration executable preflight', () => {
  it('allows the native CLI to finish a cold version probe before advertising', async () => {
    const executable = await entry("setTimeout(() => console.log('GitHub Copilot CLI 1.0.83.'), 6000);");
    const registration = await createCopilotHostRegistration({ executable });
    try { expect(registration.adapter.descriptor.providerId).toBe('copilot'); }
    finally { await registration.directory.close(); }
  }, 15000);
  it('runs a JavaScript CLI entry with the selected profile and environment before advertising', async () => {
    const previous = process.env.COPILOT_HOME;
    const executable = await entry("if (process.argv[2] !== '--version' || process.env.COPILOT_HOME !== '/selected-profile' || process.env.COPILOT_HOST_TEST !== 'yes') process.exit(1); console.log('GitHub Copilot CLI 1.0.83');");
    const registration = await createCopilotHostRegistration({ executable, copilotHome: '/selected-profile', env: { COPILOT_HOST_TEST: 'yes' },
      workspaces: [{ id: 'work', name: 'Work', path: '/work' }] });
    try {
      expect(registration.adapter.descriptor.providerId).toBe('copilot');
      expect(await registration.directory.workspaces()).toEqual([{ id: 'work', name: 'Work', path: '/work' }]);
      expect(process.env.COPILOT_HOME).toBe(previous);
    } finally { await registration.directory.close(); }
  });
  it('resolves a readable bare JavaScript entry through the selected PATH', async () => {
    const executable = await entry("console.log('GitHub Copilot CLI 1.0.83.');");
    const registration = await createCopilotHostRegistration({ executable: 'copilot.mjs', env: { PATH: dirname(executable) } });
    try { expect(registration.adapter.descriptor.providerId).toBe('copilot'); }
    finally { await registration.directory.close(); }
    await expect(createCopilotHostRegistration({ executable: 'missing.mjs', env: { PATH: dirname(executable) } })).rejects.toThrow(/not found on PATH/);
  });
  it('accepts the official CLI version output including its sentence punctuation and update hint', async () => {
    const output = "GitHub Copilot CLI 1.0.83.\nRun 'copilot update' to check for updates.";
    const registration = await createCopilotHostRegistration({ executable: await entry(`console.log(${JSON.stringify(output)});`) });
    try { expect(registration.adapter.descriptor.providerId).toBe('copilot'); }
    finally { await registration.directory.close(); }
  });
  it.each(['GitHub Copilot CLI 1.0.39.', 'GitHub Copilot CLI 1.0.82.', 'GitHub Copilot CLI 1.0.83.1', 'Other CLI 9.0.0.'])(
    'rejects unsupported or malformed version output: %s', async (output) => {
      await expect(createCopilotHostRegistration({ executable: await entry(`console.log(${JSON.stringify(output)});`) })).rejects.toThrow(/1\.0\.83 or newer/);
    });
  it('rejects unavailable and invalid CLI executables before registration', async () => {
    await expect(createCopilotHostRegistration({ executable: '/nonexistent/copilot' })).rejects.toThrow();
    await expect(createCopilotHostRegistration({ executable: await entry("console.log('wrong program')") })).rejects.toThrow(/version/);
    await expect(createCopilotHostRegistration({ executable: await entry("console.log('GitHub Copilot CLI 1.0.39')") })).rejects.toThrow(/1\.0\.83 or newer/);
    await expect(createCopilotHostRegistration({ executable: await entry("console.log('v22.0.0')") })).rejects.toThrow(/GitHub Copilot CLI/);
  });
});
