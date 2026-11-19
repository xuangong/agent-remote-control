// A fake CLI that answers its version probe after six real seconds: a child process on a real timer, so it runs in the process tier.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCopilotHostRegistration } from './copilot.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
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
});
