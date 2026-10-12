import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { SessionDirectoryClient, type SessionCatalogPage } from '../directory-client.js';
import { groupTpmWorks, type TpmMainSession } from '../tpm-main-sessions.js';
import { sessionKey } from '../session-tree.js';
import { render } from '../test/setup.js';
import type { TpmItem } from './useTpmWork.js';
import { useTpmMainSessions } from './useTpmMainSessions.js';

afterEach(() => vi.restoreAllMocks());
const target = { hostId: 'host', providerId: 'codex', nativeSessionId: 'main' };
const work: TpmItem = { key: 'work', hostId: 'host', hostName: 'Mac', online: true, unread: false,
  work: { id: 'work', revision: 1, title: 'Search', providerId: 'claude', mainNativeSessionId: 'old-main',
    mainSessionRef: { controllerId: 'controller', providerId: 'codex', nativeSessionId: 'main' },
    phase: 'clarifying', waiting: 'none', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: '', updatedAt: '', nextCheckAt: 0 } };
const session = { ...target, title: 'Search project', workspace: '/Projects/search', createdAt: '', updatedAt: '', state: 'idle' as const };
const page = (items: typeof session[], nextCursor?: string): SessionCatalogPage => ({ items, revision: '1', hasMore: !!nextCursor, nextCursor });

it('groups by Host and main provider identity rather than titles or the TPM provider', () => {
  const same = { ...work, key: 'same', work: { ...work.work, mainSessionRef: undefined, providerId: 'codex', mainNativeSessionId: 'main' } };
  const otherHost = { ...work, key: 'other-host', hostId: 'other-host' };
  const otherProvider = { ...work, key: 'other-provider', work: { ...work.work, mainSessionRef: { ...work.work.mainSessionRef!, providerId: 'opencode' } } };
  const groups = groupTpmWorks([work, same, otherHost, otherProvider], new Map([[sessionKey(target), session]]));
  expect(groups).toHaveLength(3);
  expect(groups[0]).toMatchObject({ main: { title: 'Search project', providerId: 'codex', workspace: '/Projects/search' } });
  expect(groups[0]!.works.map(item => item.key)).toEqual(['work', 'same']);
  expect(groups[1]!.main.hostId).toBe('other-host');
  expect(groups[2]!.main.providerId).toBe('opencode');
});

it('lazily shares directory pagination, caches labels, honors title events and never attaches sessions', async () => {
  const list = vi.spyOn(SessionDirectoryClient.prototype, 'list').mockImplementation(async (_provider, cursor) => cursor ? page([session]) : page([], 'next'));
  const attach = vi.spyOn(SessionDirectoryClient.prototype, 'attach');
  let onTitle!: (value: typeof session) => void;
  const transport = { onSessionTitle: (callback: typeof onTitle) => { onTitle = callback; return () => {}; } } as unknown as RemoteAgentTransport;
  let result!: Map<string, TpmMainSession>, show!: (value: boolean) => void;
  let rename!: (value: TpmMainSession[]) => void;
  function Harness() {
    const [open, setOpen] = useState(false); show = setOpen;
    const [known, setKnown] = useState<TpmMainSession[]>([]); rename = setKnown;
    result = useTpmMainSessions('http://localhost/', true, open, [work, { ...work, key: 'second' }], known, transport);
    return null;
  }
  await render(<Harness />);
  expect(list).not.toHaveBeenCalled();
  await act(async () => show(true));
  expect(list.mock.calls.map(([provider, cursor]) => [provider, cursor])).toEqual([['codex', undefined], ['codex', 'next']]);
  expect(result.get(sessionKey(target))).toMatchObject({ title: 'Search project', workspace: '/Projects/search' });
  await act(async () => { onTitle({ ...session, title: 'Renamed project' }); });
  expect(result.get(sessionKey(target))!.title).toBe('Renamed project');
  await act(async () => show(false));
  await act(async () => show(true));
  expect(list).toHaveBeenCalledTimes(2);
  await act(async () => rename([{ ...session, title: 'Confirmed title' }]));
  expect(result.get(sessionKey(target))!.title).toBe('Confirmed title');
  expect(attach).not.toHaveBeenCalled();
});

it('cancels hidden and old-scope lookups and excludes offline Hosts', async () => {
  const requests: Array<{ signal: AbortSignal; resolve(page: SessionCatalogPage): void }> = [];
  const list = vi.spyOn(SessionDirectoryClient.prototype, 'list').mockImplementation((_provider, _cursor, signal) => new Promise(resolve => requests.push({ signal: signal!, resolve })));
  const transport = {} as RemoteAgentTransport;
  let update!: (value: { scope: string; open: boolean; online: boolean; enabled: boolean }) => void;
  let result!: Map<string, TpmMainSession>;
  function Harness() {
    const [state, setState] = useState({ scope: 'http://localhost/one/', open: true, online: false, enabled: true }); update = setState;
    result = useTpmMainSessions(state.scope, state.enabled, state.open, [{ ...work, online: state.online }], [], transport);
    return null;
  }
  await render(<Harness />);
  expect(list).not.toHaveBeenCalled();
  await act(async () => update({ scope: 'http://localhost/one/', open: true, online: true, enabled: true }));
  expect(requests).toHaveLength(1);
  await act(async () => update({ scope: 'http://localhost/two/', open: true, online: true, enabled: true }));
  expect(requests[0]!.signal.aborted).toBe(true);
  await act(async () => requests[0]!.resolve(page([session])));
  expect(result.size).toBe(0);
  await act(async () => requests[1]!.resolve(page([{ ...session, title: 'New scope' }])));
  expect(result.get(sessionKey(target))!.title).toBe('New scope');
  await act(async () => update({ scope: 'http://localhost/two/', open: false, online: true, enabled: true }));
  expect(requests[1]!.signal.aborted).toBe(true);
  await act(async () => update({ scope: 'http://localhost/two/', open: true, online: true, enabled: false }));
  expect(result.size).toBe(0);
});
