import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerBuildProvenance } from './build-provenance.mjs';

test('accepts explicit Docker source identity without requiring a Git directory', { timeout: 3000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-provenance-'));
  try {
    assert.deepEqual(await controllerBuildProvenance(directory, {
      AGENT_HOST_BUILD_REVISION: 'a'.repeat(40), AGENT_HOST_BUILD_DIRTY: 'true',
    }), { revision: 'a'.repeat(40), dirty: true });
    assert.deepEqual(await controllerBuildProvenance(directory, {
      AGENT_HOST_BUILD_REVISION: 'b'.repeat(40), AGENT_HOST_BUILD_DIRTY: 'false',
    }), { revision: 'b'.repeat(40), dirty: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rejects missing or malformed explicit provenance rather than inventing a revision', { timeout: 3000 }, async () => {
  for (const environment of [
    { AGENT_HOST_BUILD_REVISION: 'a'.repeat(40) },
    { AGENT_HOST_BUILD_DIRTY: 'false' },
    { AGENT_HOST_BUILD_REVISION: 'latest', AGENT_HOST_BUILD_DIRTY: 'true' },
    { AGENT_HOST_BUILD_REVISION: 'a'.repeat(40), AGENT_HOST_BUILD_DIRTY: 'yes' },
  ]) await assert.rejects(controllerBuildProvenance('/missing-source', environment), /revision and dirty|40 lowercase|true or false/);
  await assert.rejects(controllerBuildProvenance('/missing-source', {}));
});
