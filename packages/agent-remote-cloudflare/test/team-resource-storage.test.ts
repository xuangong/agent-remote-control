import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterEach, expect, it } from 'vitest';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'team-resource-sql-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const result = await build({ stdin: { contents: `
    import { SqliteTeamResourceStorage } from './src/team-resource-storage.ts';
    import { PortableTeamResourceStore } from '../agent-remote-hosted/src/team-resources.ts';
    export class ResourceObject {
      constructor(ctx) { this.ctx = ctx; }
      async fetch(request) {
        const { action, namespace, key, bytes, prefix, input, scope, resourceId, offset } = await request.json();
        const store = new SqliteTeamResourceStorage(this.ctx.storage, namespace);
        const resources = new PortableTeamResourceStore({ storage: store });
        if (action === 'begin') return Response.json(await resources.begin(scope, input));
        if (action === 'chunk') return Response.json(await resources.chunk(scope, input));
        if (action === 'finish') { const result = await resources.finish(scope, input.uploadId); await resources.pin(scope, result.resource.resourceId); return Response.json(result); }
        if (action === 'read') return Response.json(await resources.readChunk(scope, resourceId, offset));
        if (action === 'put') { await store.put(key, new Uint8Array(bytes)); return Response.json(true); }
        if (action === 'get') { const value = await store.get(key); return Response.json(value ? [...value] : null); }
        if (action === 'list') return Response.json(await store.list(prefix));
        if (action === 'delete') { await store.delete(key); return Response.json(true); }
        return new Response('invalid', { status: 400 });
      }
    }
    export default { fetch(request, env) { return env.RESOURCES.get(env.RESOURCES.idFromName('files')).fetch(request); } };
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:*'] });
  let mf: Miniflare;
  const start = () => { mf = new Miniflare({ modules: true, script: result.outputFiles[0]!.text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { RESOURCES: { className: 'ResourceObject', useSQLite: true } }, durableObjectsPersist: join(directory, 'state') }); };
  start(); cleanup.push(() => mf.dispose());
  const request = async (body: Record<string, unknown>) => {
    const response = await mf.dispatchFetch('https://relay.example/resources', { method: 'POST', body: JSON.stringify({ namespace: 'owner-a', ...body }) });
    expect(response.status).toBe(200);
    return response.json();
  };
  return { request, async restart() { await mf.dispose(); start(); } };
}

it('retains binary chunks across Worker restarts and isolates resource namespaces', async () => {
  const f = await fixture();
  const bytes = Array.from({ length: 32768 }, (_, index) => index % 256);
  await f.request({ action: 'put', key: 'chunk-1', bytes });
  await f.request({ action: 'put', key: 'empty', bytes: [] });
  await f.restart();
  expect(await f.request({ action: 'get', key: 'chunk-1' })).toEqual(bytes);
  expect(await f.request({ action: 'get', key: 'empty' })).toEqual([]);
  expect(await f.request({ action: 'get', namespace: 'owner-b', key: 'chunk-1' })).toBeNull();
  await f.request({ action: 'put', namespace: 'owner-b', key: 'chunk-1', bytes: [9] });
  expect(await f.request({ action: 'get', key: 'chunk-1' })).toEqual(bytes);
});

it('lists only matching keys and deletes without affecting another namespace', async () => {
  const f = await fixture();
  for (const key of ['manifest-a', 'manifest-b', 'chunk-a', 'manifest_%']) await f.request({ action: 'put', key, bytes: [1, 0, 255] });
  await f.request({ action: 'put', namespace: 'owner-b', key: 'manifest-a', bytes: [2] });
  expect(await f.request({ action: 'list', prefix: 'manifest-' })).toEqual(['manifest-a', 'manifest-b']);
  expect(await f.request({ action: 'list', prefix: 'manifest_' })).toEqual(['manifest_%']);
  await f.request({ action: 'delete', key: 'manifest-a' });
  expect(await f.request({ action: 'get', key: 'manifest-a' })).toBeNull();
  expect(await f.request({ action: 'get', namespace: 'owner-b', key: 'manifest-a' })).toEqual([2]);
});

it('transfers a file larger than the Team text quota and restores verified chunks after restart', async () => {
  const f = await fixture();
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
