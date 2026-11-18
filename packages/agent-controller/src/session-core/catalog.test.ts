import type { RemoteSessionSummary } from '@orchardworks/agent-session-runtime';
import { describe, expect, it } from 'vitest';

import { catalogSessionStates, createSessionCatalog, type SessionCatalogPorts } from './catalog.js';

const summary = (nativeSessionId: string, extra: Partial<RemoteSessionSummary> = {}): RemoteSessionSummary => ({
  nativeSessionId, providerId: 'codex', title: nativeSessionId, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', state: 'idle', ...extra,
});

describe('catalog session states', () => {
  it('shares the state and update time of each session', () => {
    expect(catalogSessionStates([summary('a'), summary('b', { state: 'running' })])).toEqual([
      { providerId: 'codex', nativeSessionId: 'a', state: 'idle', updatedAt: Date.parse('2026-01-02T00:00:00.000Z') },
      { providerId: 'codex', nativeSessionId: 'b', state: 'running', updatedAt: Date.parse('2026-01-02T00:00:00.000Z') },
    ]);
  });

  it('calls an unavailable session failed, and leaves an unknown one out', () => {
    expect(catalogSessionStates([summary('a', { state: 'unavailable' }), summary('b', { state: 'unknown' })]).map(row => [row.nativeSessionId, row.state])).toEqual([['a', 'failed']]);
  });

  it('leaves an update time out of its row when it is not a valid instant or is before the epoch', () => {
    const rows = catalogSessionStates([summary('a', { updatedAt: 'later' }), summary('b', { updatedAt: '1969-12-31T00:00:00.000Z' }), summary('c', { updatedAt: '1970-01-01T00:00:00.000Z' })]);
    expect(rows.map(row => 'updatedAt' in row)).toEqual([false, false, true]);
  });
});

function catalogPorts(extra: Partial<SessionCatalogPorts> = {}) {
  const pages = [{ items: [summary('a'), summary('b')], nextCursor: 'next' }, { items: [summary('c')], nextCursor: undefined }];
  const requests: unknown[] = [];
  const ports: SessionCatalogPorts = {
    providerIds: () => ['codex', 'claude'],
    enabled: providerId => providerId !== 'claude',
    catalog: providerId => providerId === 'codex' ? {
      page: async request => { requests.push(request); return pages[requests.length - 1]!; },
      session: async id => summary(`catalog-${id}`),
    } as ReturnType<SessionCatalogPorts['catalog']> : undefined,
    directory: () => undefined,
    adapter: () => ({ readSessionHistory: async (id: string) => ({ id }) as never }),
    runtimeState: () => undefined,
    ...extra,
  };
  return { catalog: createSessionCatalog(ports), requests };
}

describe('the session catalog', () => {
  it('lists the providers that are enabled', () => {
    expect(catalogPorts().catalog.providers()).toEqual(['codex']);
  });

  it('reads every page of a provider\'s sessions, 100 at a time', async () => {
    const run = catalogPorts();
    expect((await run.catalog.sessions('codex')).map(item => item.nativeSessionId)).toEqual(['a', 'b', 'c']);
    expect(run.requests).toEqual([{ limit: 100 }, { limit: 100, cursor: 'next' }]);
  });

  it('has no sessions for a disabled or unknown provider', async () => {
    const run = catalogPorts();
    expect(await run.catalog.sessions('claude')).toEqual([]);
    expect(await run.catalog.sessions('copilot')).toEqual([]);
  });

  it('reads a summary from the directory when it reads one, else from the catalog, and none for a disabled provider', async () => {
    expect((await catalogPorts().catalog.session({ providerId: 'codex', nativeSessionId: 'x' }))?.nativeSessionId).toBe('catalog-x');
    const own = catalogPorts({ directory: () => ({ sessionSummary: async id => summary(`directory-${id}`) }) });
    expect((await own.catalog.session({ providerId: 'codex', nativeSessionId: 'x' }))?.nativeSessionId).toBe('directory-x');
    expect(await own.catalog.session({ providerId: 'claude', nativeSessionId: 'x' })).toBeUndefined();
  });

  it('reads native history through the adapter, and refuses a disabled provider or one without history', async () => {
    const run = catalogPorts();
    await expect(run.catalog.history({ providerId: 'codex', nativeSessionId: 'x' }, {} as never)).resolves.toEqual({ id: 'x' });
    await expect(run.catalog.history({ providerId: 'claude', nativeSessionId: 'x' }, {} as never)).rejects.toMatchObject({ code: 'native_session_unavailable' });
    const none = catalogPorts({ adapter: () => ({}) });
    await expect(none.catalog.history({ providerId: 'codex', nativeSessionId: 'x' }, {} as never)).rejects.toThrow('Native history is unavailable for this provider.');
  });

  it('reports the live state of a session that has a runtime, and nothing otherwise', () => {
    const quiet = { connected: true, synchronized: true, closed: false, status: 'idle', activeTurn: false, pendingInteractions: 0, commandWork: 0, settingWork: false } as const;
    const run = catalogPorts({ runtimeState: (_provider, id) => id === 'live' ? quiet : undefined });
    expect(run.catalog.liveState({ providerId: 'codex', nativeSessionId: 'live' })).toBeDefined();
    expect(run.catalog.liveState({ providerId: 'codex', nativeSessionId: 'asleep' })).toBeUndefined();
  });
});
