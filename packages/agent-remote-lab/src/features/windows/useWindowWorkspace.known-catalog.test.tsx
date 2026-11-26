import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WindowWorkspaceClient, WindowRequestError } from '@orchardworks/agent-client';
import { createWindowView, type WindowGroup, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { createCompositionDocument } from '../../kernel/session-composition.js';
import { readCatalogCache, writeCatalogCache } from '../../kernel/window-catalog-cache.js';
import { useWindowWorkspace } from './useWindowWorkspace.js';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; container?.remove(); container = undefined;
  vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/');
});
const scope = 'https://relay.test/u/' + 'a'.repeat(64) + '/';
const group = (id: string): WindowGroup => ({ window: { schemaVersion: 3, id, revision: 1, title: id, selectedPrimaryViewId: 'main', selectedViewId: 'main',
  views: [createWindowView('main', undefined, 'primary')] } satisfies WorkspaceWindow });
async function mount(options: { enabled: boolean; canRead: boolean }) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const composition = createCompositionDocument(scope);
  let current!: ReturnType<typeof useWindowWorkspace>;
  function Harness() { current = useWindowWorkspace(scope, true, options.enabled, composition, true, undefined, options.canRead); return null; }
  await act(async () => root!.render(<Harness />));
  return () => current;
}
const answers = (groups: WindowGroup[]) => {
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockResolvedValue(groups);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => ({ window: groups.find(item => item.window.id === id)!.window }));
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
};

it('lists the catalog the device stored in the first render, before the Relay may be asked, and calls it stored, not confirmed', async () => {
  writeCatalogCache(scope, [group('a'), group('b')]);
  const listing = vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups');
  const read = await mount({ enabled: false, canRead: true });
  expect(read().groups.map(item => item.window.id)).toEqual(['a', 'b']);
  expect(read().groupsKnowledge).toBe('stored');
  expect(listing).not.toHaveBeenCalled();
});

it('knows nothing of a catalog it has not read: empty and unknown, never confirmed empty, until a load answers', async () => {
  const read = await mount({ enabled: false, canRead: true });
  expect(read().groups).toEqual([]);
  expect(read().groupsKnowledge).toBe('unknown');
});

it('does not read the stored catalog while the device holds no lease', async () => {
  writeCatalogCache(scope, [group('a')]);
  const read = await mount({ enabled: false, canRead: false });
  expect(read().groups).toEqual([]);
  expect(read().groupsKnowledge).toBe('unknown');
});

it('confirms the catalog when the Relay answers, an empty one included, and keeps the answer for the next launch', async () => {
  answers([group('a')]);
  const first = await mount({ enabled: true, canRead: true });
  await vi.waitFor(() => expect(first().groupsKnowledge).toBe('confirmed'));
  expect(readCatalogCache(scope).map(item => item.window.id)).toEqual(['a']);
});

it('says an empty catalog is empty once the Relay answered so', async () => {
  answers([]);
  const read = await mount({ enabled: true, canRead: true });
  await vi.waitFor(() => expect(read().groupsKnowledge).toBe('confirmed'));
  expect(read().groups).toEqual([]);
});

it('keeps the stored catalog on screen when the Relay cannot be reached', async () => {
  writeCatalogCache(scope, [group('a')]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockRejectedValue(new Error('offline'));
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockRejectedValue(new Error('offline'));
  const read = await mount({ enabled: true, canRead: true });
  await act(async () => { await Promise.resolve(); });
  expect(read().groups.map(item => item.window.id)).toEqual(['a']);
  expect(read().groupsKnowledge).toBe('stored');
});

it('drops a stored group the Relay no longer has once it says so', async () => {
  writeCatalogCache(scope, [group('a'), group('gone')]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockResolvedValue([group('a')]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => {
    if (id === 'gone') throw new WindowRequestError('Not found', 404, 'not_found');
    return { window: group(id).window };
  });
  const read = await mount({ enabled: true, canRead: true });
  await vi.waitFor(() => expect(read().groups.map(item => item.window.id)).toEqual(['a']));
});
