import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerEnvironment } from './entrypoint.mjs';

test('uses a secret file initially and saved device credentials on restart', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-container-'));
  try {
    const keyfile = join(root, 'pairing'); await writeFile(keyfile, 'invite-test\n');
    const input = { AGENT_HOST_STATE_DIR: root, AGENT_HOST_SERVER: 'https://relay.example', AGENT_HOST_REMOTE_KEY_FILE: keyfile };
    assert.equal((await containerEnvironment(input)).AGENT_HOST_REMOTE_KEY, 'invite-test');
    await writeFile(join(root, 'connection.json'), JSON.stringify({ serverUrl: input.AGENT_HOST_SERVER, remoteKey: 'device-test' }));
    await rm(keyfile);
    const restarted = await containerEnvironment(input);
    assert.equal(restarted.AGENT_HOST_REMOTE_KEY, undefined);
    assert.equal(restarted.AGENT_HOST_SERVER, undefined);
    assert.equal(restarted.AGENT_HOST_REMOTE_KEY_FILE, undefined);
    await assert.rejects(containerEnvironment({ ...input, AGENT_HOST_SERVER: 'https://different.example' }), /another Relay/);
  } finally { await rm(root, { force: true, recursive: true }); }
});
