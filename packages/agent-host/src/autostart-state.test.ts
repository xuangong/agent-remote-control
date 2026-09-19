import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearAutostartConnection, prepareAutostartConnection, resolveAutostartConnection } from './autostart-state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('reads an existing macOS startup envelope and clears only its owned generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-autostart-')); roots.push(root);
  const connection = { serverUrl: 'https://relay.test', remoteKey: 'pending-key', environment: { AGENT_HOST_WORKSPACE: '/work' } };
  await prepareAutostartConnection(root, connection);
  await rename(join(root, 'autostart-start.json'), join(root, 'launchd-start.json'));
  const original = await resolveAutostartConnection(root, {});
  expect(original.connection.remoteKey).toBe('pending-key');
  await prepareAutostartConnection(root, { ...connection, remoteKey: 'replacement-key' });
  await clearAutostartConnection(root, original.pendingId);
  await expect(readFile(join(root, 'launchd-start.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const replacement = await resolveAutostartConnection(root, {});
  expect(replacement.connection.remoteKey).toBe('replacement-key');
  await clearAutostartConnection(root, replacement.pendingId);
  await expect(readFile(join(root, 'autostart-start.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
