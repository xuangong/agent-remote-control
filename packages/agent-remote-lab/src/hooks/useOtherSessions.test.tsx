import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DirectoryError, SessionDirectoryClient, type SessionCatalogPage } from '../directory-client.js';
import { projectBotRoster } from '../bot-roster.js';
import { createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { useOtherSessions, type OtherSessionSource } from './useOtherSessions.js';
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.restoreAllMocks(); });
const page = (id: string, hasMore = false, nextCursor?: string): SessionCatalogPage => ({ revision: 'r', hasMore, nextCursor, items: [{ providerId: 'p', nativeSessionId: id, title: id, createdAt: '2026-01-01', updatedAt: id === 'new' ? '2026-11-08' : '2026-01-01', state: 'idle' }] });
const source = (id: string): OtherSessionSource => ({ id, hostId: id, providerId: 'p', directory: new SessionDirectoryClient('https://test/', undefined, id), online: true });
async function mount(initial: OtherSessionSource[], active = true) { let value!: ReturnType<typeof useOtherSessions>, sources = initial, enabled = active; function Harness() { value = useOtherSessions(sources, enabled); return null; } root = createRoot(document.createElement('div')); await act(async () => root!.render(<Harness />)); return { read: () => value, render: async (next: OtherSessionSource[], active = true) => { sources = next; enabled = active; await act(async () => root!.render(<Harness />)); } }; }
it('fetches only while enabled, merges pages globally and loads a requested source', async () => {
  const list = vi.spyOn(SessionDirectoryClient.prototype, 'list').mockImplementation(async (_p, cursor) => cursor ? page('new') : page('old', true, 'next')); const a = source('a'), b = source('b'); const harness = await mount([a, b], false); expect(list).not.toHaveBeenCalled();
  await harness.render([a, b]); expect(harness.read().sessions.map(s => s.hostId)).toEqual(['a', 'b']); await act(async () => harness.read().loadMore('b')); expect(harness.read().sessions[0]).toMatchObject({ hostId: 'b', nativeSessionId: 'new' }); expect(harness.read().sources.find(s => s.id === 'b')?.hasMore).toBe(false);
});
it('rejects an old source response after its authorized descriptor changes', async () => {
  let resolve!: (page: SessionCatalogPage) => void; let oldSignal!: AbortSignal;
  vi.spyOn(SessionDirectoryClient.prototype, 'list').mockImplementation(function (this: SessionDirectoryClient, _p, _c, signal) { if (this === a.directory) { oldSignal = signal!; return new Promise(done => { resolve = done; }); } return Promise.resolve(page('new')); }); const a = source('a'), b = source('b'); const harness = await mount([a]);
  await harness.render([b]); await act(async () => resolve(page('old'))); expect(oldSignal.aborted).toBe(true); expect(harness.read().sessions.map(s => s.hostId)).toEqual(['b']);
});
it('retains loaded pages offline and requires explicit refresh after cursor expiry', async () => {
  const a = source('a'); const list = vi.spyOn(SessionDirectoryClient.prototype, 'list').mockResolvedValue(page('old', true, 'next')); const harness = await mount([a]);
  await harness.render([{ ...a, online: false }]); expect(harness.read().sessions).toHaveLength(1); expect(harness.read().sources[0]?.online).toBe(false); expect(list).toHaveBeenCalledTimes(1);
  await harness.render([a]); list.mockRejectedValueOnce(new DirectoryError('Expired', 'cursor_expired', 410)); await act(async () => harness.read().loadMore('a')); expect(harness.read().sources[0]?.expired).toBe(true); expect(harness.read().sessions).toHaveLength(1);
  const count = list.mock.calls.length; await act(async () => harness.read().loadMore('a')); expect(list).toHaveBeenCalledTimes(count);
  list.mockResolvedValue(page('new')); await act(async () => harness.read().refresh('a')); expect(harness.read().sources[0]?.expired).toBe(false); expect(harness.read().sessions[0]?.nativeSessionId).toBe('new');
});
it('removes newly grouped fallback sessions without another directory request', async () => {
  const list = vi.spyOn(SessionDirectoryClient.prototype, 'list').mockResolvedValue(page('old')); const harness = await mount([source('h')]); const groups: WindowGroup[] = [];
  expect(projectBotRoster(groups, harness.read().sessions, () => 'idle').other).toHaveLength(1);
  groups.push({ window: { schemaVersion: 3, id: 'w', revision: 0, title: 'w', selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', { hostId: 'h', providerId: 'p', nativeSessionId: 'old', title: 'old' }, 'primary')] } });
  expect(projectBotRoster(groups, harness.read().sessions, () => 'idle').other).toEqual([]); expect(list).toHaveBeenCalledTimes(1);
});
it('aborts and ignores a response after leaving Bot mode', async () => {
  let complete!: (page: SessionCatalogPage) => void, signal!: AbortSignal; const a = source('a');
  vi.spyOn(SessionDirectoryClient.prototype, 'list').mockImplementation((_p, _c, current) => { signal = current!; return new Promise(done => { complete = done; }); });
  const harness = await mount([a]); await harness.render([a], false); await act(async () => complete(page('old'))); expect(signal.aborted).toBe(true); expect(harness.read().sessions).toEqual([]);
});
