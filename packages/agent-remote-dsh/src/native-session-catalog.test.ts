import { describe, expect, it, vi } from 'vitest';
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session';
import { createNativeSessionCatalog, type NativeSessionCatalogServices } from './native-session-catalog.js';
import type { RemoteSessionSummary } from './remote-host-catalog.js';

const createdAt = 1_725_000_000_000;
function header(id: string, fields: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt, cwd: `/tmp/${id}`, isSeeded: false, ...fields };
}
function services(headers: SessionHeader[], values: Readonly<Record<string, unknown>> = {}): NativeSessionCatalogServices {
  return {
    sessionQuery: { listSessions: async () => headers.map((header) => ({ header })) },
    sessionProjectionCache: { cachedSnapshot: () => ({ values }) },
  };
}

describe('createNativeSessionCatalog', () => {
  it('reads an optional projection service through the Cordis service accessor', async () => {
    const source = {
      sessionQuery: services([header('cold')]).sessionQuery,
      get sessionProjectionCache(): never { throw new Error('cannot get property without inject'); },
      get(name: string) {
        expect(name).toBe('sessionProjectionCache');
        return { cachedSnapshot: () => ({ values: { title: 'Native cached title' } }) };
      },
    };
    expect((await createNativeSessionCatalog(source, () => [])())[0].title).toBe('Native cached title');
  });

  it('reads cold identity, title, activity and model from native headers and cached projections', async () => {
    const source = services([header('cold')], {
      title: 'Persisted title', sessionListMetadata: { blank: false, lastPromptAt: createdAt + 250 },
      modelSelection: { lastUsed: { provider: 'native', model: 'used-model' }, next: { provider: 'native', model: 'next-model' } },
    });
    const cachedSnapshot = vi.spyOn(source.sessionProjectionCache!, 'cachedSnapshot');
    const read = createNativeSessionCatalog(source, () => []);

    expect(await read()).toEqual([{
      nativeSessionId: 'cold', providerId: 'dsh', title: 'Persisted title', workspace: '/tmp/cold',
      createdAt: '2024-08-30T06:40:00.000Z', updatedAt: '2024-08-30T06:40:00.250Z',
      model: 'used-model', state: 'idle',
    }]);
    expect(cachedSnapshot).toHaveBeenCalledWith(header('cold'), 0, ['title', 'modelSelection', 'sessionListMetadata']);
  });

  it('preserves the real creation time and identity when optional cached hints are absent', async () => {
    const source = services([header('cold')]);
    delete (source as { sessionProjectionCache?: unknown }).sessionProjectionCache;
    const [item] = await createNativeSessionCatalog(source, () => [])();
    expect(item).toMatchObject({ title: 'cold', createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(createdAt).toISOString() });
    expect(item).not.toHaveProperty('model');
  });

  it('uses the selected model before any request and clamps stale prompt times to creation', async () => {
    const source = services([header('cold')], {
      title: null, sessionListMetadata: { lastPromptAt: createdAt - 100 },
      modelSelection: { lastUsed: null, next: { provider: 'native', model: 'selected-model' } },
    });
    expect((await createNativeSessionCatalog(source, () => [])())[0]).toMatchObject({
      title: 'cold', model: 'selected-model', updatedAt: new Date(createdAt).toISOString(),
    });
  });

  it('lists ordinary forks while excluding subagent and workspace-less persisted sessions', async () => {
    const source = services([
      header('ordinary'), header('child', { parentSession: SessionId('parent') }),
      header('subagent', { origin: 'subagent' }), header('seeded', { isSeeded: true }),
      header('no-workspace', { cwd: undefined }),
    ]);
    expect((await createNativeSessionCatalog(source, () => [])()).map((item) => item.nativeSessionId)).toEqual(['ordinary', 'child', 'seeded']);
  });

  it('uses real seeded headers without reading cache rows whose inherited prefix is unknown', async () => {
    const source = services([header('seeded', { isSeeded: true, parentSession: SessionId('parent') })], {
      title: 'A cache row without a proven inherited prefix',
    });
    const cache = vi.spyOn(source.sessionProjectionCache!, 'cachedSnapshot');
    const items = await createNativeSessionCatalog(source, () => [])();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'seeded', createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(createdAt).toISOString() });
    expect(cache).not.toHaveBeenCalled();
  });

  it('uses live metadata once a cold session is restored during the header read', async () => {
    let release!: (records: { header: SessionHeader }[]) => void;
    const source: NativeSessionCatalogServices = {
      sessionQuery: { listSessions: () => new Promise((resolve) => { release = resolve; }) },
    };
    const live: RemoteSessionSummary[] = [];
    const reading = createNativeSessionCatalog(source, () => live)();
    live.push({
      nativeSessionId: 'cold', providerId: 'dsh', title: 'Live title', model: 'live-model',
      createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(createdAt + 500).toISOString(), state: 'running',
    });
    release([{ header: header('cold') }]);
    expect(await reading).toEqual(live);
  });

  it('reports native listing failures without exposing storage errors or returning an empty directory', async () => {
    const source = services([]);
    source.sessionQuery.listSessions = async () => { throw new Error('/private/native/storage could not open'); };
    await expect(createNativeSessionCatalog(source, () => [])()).rejects.toMatchObject({
      code: 'catalog_unavailable', status: 503, message: 'Native Remote Session catalog is unavailable.',
    });
  });

  it('rejects unavailable metadata services and invalid creation times instead of inventing timestamps', async () => {
    await expect(createNativeSessionCatalog({}, () => [])()).rejects.toMatchObject({ code: 'catalog_unavailable' });
    await expect(createNativeSessionCatalog(services([header('broken', { createdAt: NaN })]), () => [])())
      .rejects.toMatchObject({ code: 'catalog_unavailable' });
  });
});
