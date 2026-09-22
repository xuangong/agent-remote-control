import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createLoginStartup } from './index.js';

it('selects the current OS service without installing or starting it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'service-selection-'));
  try {
    const service = createLoginStartup({ stateDir: directory, home: directory, nodePath: process.execPath, cliPath: join(directory, 'cli.js'), cwd: directory, path: process.env.PATH ?? '' });
    expect(service?.kind).toBe(({ win32: 'windows', linux: 'systemd', darwin: 'launchd' } as Record<string, string>)[process.platform]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
