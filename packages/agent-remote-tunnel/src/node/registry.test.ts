import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createPreviewRegistry } from './index.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function location() {
  const dir = await mkdtemp(join(tmpdir(), 'preview-registry-'));
  dirs.push(dir);
  return join(dir, 'registrations.json');
}

describe('PreviewRegistry', () => {
  test('persists registrations atomically and reuses an active target while merging sources', async () => {
    const filePath = await location();
    const registry = await createPreviewRegistry({ filePath, probe: false });
    const first = await registry.register({ target: 'http://localhost:5173/x', source: { sessionId: 's1', itemId: 'i1' } });
    const second = await registry.register({ target: 'http://127.0.0.1:5173/y', source: { sessionId: 's2', itemId: 'i2' } });
    expect(second.id).toBe(first.id);
    expect(second.sources).toEqual([{ sessionId: 's1', itemId: 'i1' }, { sessionId: 's2', itemId: 'i2' }]);
    expect(JSON.parse(await readFile(filePath, 'utf8')).registrations).toHaveLength(1);
    await registry.close();
    const recovered = await createPreviewRegistry({ filePath, probe: false });
    expect(recovered.lookup(first.id)?.target).toBe('http://127.0.0.1:5173');
    expect(recovered.snapshot().epoch).not.toBe(registry.snapshot().epoch);
    await recovered.close();
  });

  test('serializes concurrent registration decisions and preserves one active target', async () => {
    const registry = await createPreviewRegistry({ filePath: await location(), probe: false, maxRecords: 1 });
    const [first, second] = await Promise.all([
      registry.register({ target: 'http://127.0.0.1:5173/one', source: { sessionId: 's1', itemId: 'i1' } }),
      registry.register({ target: 'http://localhost:5173/two', source: { sessionId: 's2', itemId: 'i2' } }),
    ]);
    expect(second.id).toBe(first.id);
    expect(registry.snapshot().registrations).toHaveLength(1);
    expect(registry.snapshot().revision).toBe(2);
    await registry.close();
  });

  test('restores cancellation signals for active registrations', async () => {
    const filePath = await location();
    const registry = await createPreviewRegistry({ filePath, probe: false });
    const entry = await registry.register({ target: 'http://127.0.0.1:5173', source: { sessionId: 's', itemId: 'i' } });
    await registry.close();
    const recovered = await createPreviewRegistry({ filePath, probe: false });
    const signal = recovered.signal(entry.id);
    expect(signal.aborted).toBe(false);
    await recovered.unregister(entry.id);
    expect(signal.aborted).toBe(true);
    await recovered.close();
  });

  test('expires at the original fixed deadline and cancels attached work on revoke', async () => {
    const filePath = await location();
    let now = 1000;
    const registry = await createPreviewRegistry({ filePath, ttlMs: 100, now: () => now, probe: false });
    const entry = await registry.register({ target: 'http://127.0.0.1:5173', source: { sessionId: 's', itemId: 'i' } });
    const signal = registry.signal(entry.id);
    now = 1101;
    expect(registry.lookup(entry.id)?.status).toBe('expired');
    expect(signal.aborted).toBe(true);
    expect((await registry.unregister(entry.id))?.status).toBe('unregistered');
    await registry.close();
  });

  test('fails closed when state cannot be replaced', async () => {
    const registry = await createPreviewRegistry({ filePath: await location(), probe: false });
    await registry.close();
    await expect(registry.register({ target: 'http://127.0.0.1:5173', source: { sessionId: 's', itemId: 'i' } })).rejects.toThrow(/closed/i);
  });

  test('rejects corrupt persisted descriptors instead of restoring routes', async () => {
    const filePath = await location();
    await writeFile(filePath, JSON.stringify({ version: 1, revision: 1, registrations: [{ id: 'long-enough-corrupt-id', target: 'http://example.com:80', status: 'active', createdAt: 1, expiresAt: 2, revision: 1, pathMode: 'strip', sources: [] }] }));
    await expect(createPreviewRegistry({ filePath, probe: false })).rejects.toThrow(/invalid/i);
  });

  test('keeps source descriptors within the uplink snapshot schema', async () => {
    const filePath = await location();
    const registry = await createPreviewRegistry({ filePath, probe: false });
    await expect(registry.register({ target: 'http://127.0.0.1:5173', source: { sessionId: 's'.repeat(257), itemId: 'i' } })).rejects.toThrow(/source/i);
    await registry.close();
    const sources = Array.from({ length: 257 }, (_, index) => ({ sessionId: `s${index}`, itemId: `i${index}` }));
    await writeFile(filePath, JSON.stringify({ version: 1, revision: 1, registrations: [{
      id: 'long-enough-preview-id', target: 'http://127.0.0.1:5173', status: 'active', createdAt: 1, expiresAt: 2,
      revision: 1, pathMode: 'strip', sources,
    }] }));
    await expect(createPreviewRegistry({ filePath, probe: false })).rejects.toThrow(/invalid/i);
  });
});
