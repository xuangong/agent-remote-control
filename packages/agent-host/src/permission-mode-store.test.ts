import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SessionPermissionModeStore } from './permission-mode-store.js';

const modes = ['default', 'bypassPermissions'] as const;
const accepts = (mode: unknown): mode is typeof modes[number] => modes.includes(mode as typeof modes[number]);

it('keeps the last confirmed mode per session privately and ignores files it cannot trust', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-permission-modes-'));
  const directory = join(root, 'claude');
  try {
    const store = new SessionPermissionModeStore(directory, accepts);
    expect(await store.read('a')).toBeUndefined();
    await Promise.all([store.write('a', 'bypassPermissions'), store.write('b', 'default'), store.write('a', 'default'), store.write('a', 'bypassPermissions')]);
    const reopened = new SessionPermissionModeStore(directory, accepts);
    expect(await reopened.read('a')).toBe('bypassPermissions');
    expect(await reopened.read('b')).toBe('default');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    for (const file of files) expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    // A file naming another session, an unknown mode or invalid JSON reads as no saved mode.
    await writeFile(join(directory, files[0]!), JSON.stringify({ sessionId: 'other', permissionMode: 'bypassPermissions' }));
    await writeFile(join(directory, files[1]!), JSON.stringify({ sessionId: 'b', permissionMode: 'everything' }));
    expect([await reopened.read('a'), await reopened.read('b')]).toEqual([undefined, undefined]);
    await writeFile(join(directory, files[0]!), '{');
    expect(await reopened.read('a')).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
