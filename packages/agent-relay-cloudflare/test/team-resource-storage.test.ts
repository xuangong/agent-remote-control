import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { PortableTeamResourceStore } from '@orchardworks/agent-relay-core';
import { SqliteTeamResourceStorage } from '../src/team-resource-storage.js';
import { sqliteStorage } from './sqlite-storage.js';

/** The Team resource store over one storage; each request opens the stores again, so a restart changes nothing the test can see. */
function fixture() {
  const { storage } = sqliteStorage();
  const request = async (body: Record<string, any>) => {
    const { action, namespace = 'owner-a', key, bytes, prefix, input, scope, resourceId, offset } = body;
    const store = new SqliteTeamResourceStorage(storage, namespace);
    const resources = new PortableTeamResourceStore({ storage: store });
    const through = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));
    if (action === 'begin') return through(await resources.begin(scope, input));
    if (action === 'chunk') return through(await resources.chunk(scope, input));
    if (action === 'finish') { const result = await resources.finish(scope, input.uploadId); await resources.pin(scope, result.resource.resourceId); return through(result); }
    if (action === 'read') return through(await resources.readChunk(scope, resourceId, offset));
    if (action === 'put') { await store.put(key, new Uint8Array(bytes)); return true; }
    if (action === 'get') { const value = await store.get(key); return value ? [...value] : null; }
    if (action === 'list') return through(await store.list(prefix));
    if (action === 'delete') { await store.delete(key); return true; }
    throw new Error('invalid');
  };
  return { request, async restart() {} };
}

it('retains binary chunks across restarts and isolates resource namespaces', async () => {
  const f = fixture();
  const bytes = Array.from({ length: 32768 }, (_, index) => index % 256);
  await f.request({ action: 'put', key: 'chunk-1', bytes });
  await f.restart();
  expect(await f.request({ action: 'get', key: 'chunk-1' })).toEqual(bytes);
  expect(await f.request({ action: 'get', namespace: 'owner-b', key: 'chunk-1' })).toBeNull();
  await f.request({ action: 'put', namespace: 'owner-b', key: 'chunk-1', bytes: [9] });
  expect(await f.request({ action: 'get', key: 'chunk-1' })).toEqual(bytes);
});

it('lists only matching keys and deletes without affecting another namespace', async () => {
  const f = fixture();
  for (const key of ['manifest-a', 'manifest-b', 'chunk-a', 'manifest_%']) await f.request({ action: 'put', key, bytes: [1, 0, 255] });
  await f.request({ action: 'put', namespace: 'owner-b', key: 'manifest-a', bytes: [2] });
  expect(await f.request({ action: 'list', prefix: 'manifest-' })).toEqual(['manifest-a', 'manifest-b']);
  expect(await f.request({ action: 'list', prefix: 'manifest_' })).toEqual(['manifest_%']);
  await f.request({ action: 'delete', key: 'manifest-a' });
  expect(await f.request({ action: 'get', key: 'manifest-a' })).toBeNull();
  expect(await f.request({ action: 'get', namespace: 'owner-b', key: 'manifest-a' })).toEqual([2]);
});

it('transfers a file larger than the Team text quota and restores verified chunks after restart', async () => {
  const f = fixture();
  const bytes = Buffer.alloc(300_007);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const scope = 'team:fixture';
  const input = { uploadId: 'archive', name: 'diagnostics.zip', mediaType: 'application/zip', byteLength: bytes.length, sha256 };
  expect(await f.request({ action: 'begin', scope, input })).toMatchObject({ offset: 0 });
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    await f.request({ action: 'chunk', scope, input: { uploadId: input.uploadId, offset, contentBase64: bytes.subarray(offset, offset + 32768).toString('base64') } });
  }
  const receipt = await f.request({ action: 'finish', scope, input }) as { resource: { resourceId: string; sha256: string } };
  expect(receipt.resource.sha256).toBe(sha256);
  await f.restart();
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    const chunk = await f.request({ action: 'read', scope, resourceId: receipt.resource.resourceId, offset }) as { contentBase64: string };
    chunks.push(Buffer.from(chunk.contentBase64, 'base64'));
  }
  expect(Buffer.concat(chunks)).toEqual(bytes);
});

it('refuses a record over 128 KiB and a key that is empty or over 512 characters', async () => {
  const f = fixture();
  await expect(f.request({ action: 'put', key: 'big', bytes: Array.from({ length: 128 * 1024 + 1 }, () => 1) })).rejects.toThrow(/128 KiB/);
  await f.request({ action: 'put', key: 'edge', bytes: Array.from({ length: 128 * 1024 }, () => 1) });
  await expect(f.request({ action: 'put', key: '', bytes: [1] })).rejects.toThrow(/Invalid resource storage key/);
  await expect(f.request({ action: 'get', key: 'k'.repeat(513) })).rejects.toThrow(/Invalid resource storage key/);
});
