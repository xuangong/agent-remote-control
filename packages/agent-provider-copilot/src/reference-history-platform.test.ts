import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// Windows does not provide these POSIX-only open flags.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: 0, O_NONBLOCK: 0 } };
});

import { readCopilotHistoryPage } from './reference-history.js';

it('rejects a final-file symlink even without POSIX no-follow support', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copilot-reference-platform-'));
  try {
    const id = randomUUID(), profile = join(root, 'profile'), directory = join(profile, 'session-state', id);
    await mkdir(directory, { recursive: true });
    const external = join(root, 'external.jsonl');
    await writeFile(external, JSON.stringify({ id: randomUUID(), timestamp: new Date(0).toISOString(),
      parentId: null, type: 'session.start', data: { sessionId: id } }) + '\n');
    await symlink(external, join(directory, 'events.jsonl'));
    await expect(readCopilotHistoryPage(profile, id, {})).rejects.toThrow(/scope|unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
