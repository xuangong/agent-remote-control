import { expect, it } from 'vitest';
import { createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { commandSessions, sessionSubtitle, sessionViewLocation } from './command-items.js';

const session = (id: string, title = id, hostId = 'local') => ({ hostId, providerId: 'claude', nativeSessionId: id, title });
const window = (id: string, sessions: string[]): WorkspaceWindow => ({ schemaVersion: 3, id, revision: 0, title: id, selectedPrimaryViewId: null, selectedViewId: null,
  views: sessions.map((native, index) => createWindowView(`${id}${index}`, session(native))) });

it('joins sessions from every source once, keeping the first known title', () => {
  const sessions = commandSessions([session('a', ''), { ...session('b'), hostId: undefined }], [session('a', 'Alpha'), session('c')], [session('b', 'Other title')]);
  expect(sessions.map(item => [item.nativeSessionId, item.title])).toEqual([['a', 'Alpha'], ['b', 'b'], ['c', 'c']]);
  // An entry without a Host is a local one, and keeps only the identity.
  expect(Object.keys(sessions[1]!).sort()).toEqual(['hostId', 'nativeSessionId', 'providerId', 'title']);
  expect(commandSessions([session('d', '')])[0]!.title).toBe('d');
});

it('names the Host and, when known, the provider', () => {
  const hosts = [{ id: 'mac', name: 'Studio Mac', online: true, providers: [{ providerId: 'claude', displayName: 'Claude Code' }] }, { id: 'pi', name: 'Pi', online: false }];
  expect(sessionSubtitle(session('a', 'a', 'mac'), hosts, [])).toBe('Studio Mac · Claude Code');
  expect(sessionSubtitle(session('a', 'a', 'pi'), hosts, [])).toBe('Pi');
  expect(sessionSubtitle(session('a'), hosts, [{ providerId: 'claude', displayName: 'Claude' }])).toBe('Lab server · Claude');
  expect(sessionSubtitle(session('a'), [{ id: 'local', name: 'Test Host', online: true }], [])).toBe('Test Host');
  expect(sessionSubtitle(session('a', 'a', 'gone'), hosts, [])).toBeUndefined();
});

it('finds the view showing a session, in the current Window first', () => {
  const windows = [window('A', ['x', 'y']), window('B', ['y', 'z'])];
  const key = (id: string) => JSON.stringify(['local', 'claude', id]);
  expect(sessionViewLocation(windows, 'B', key('y'))).toEqual({ windowId: 'B', viewId: 'B0' });
  expect(sessionViewLocation(windows, 'A', key('y'))).toEqual({ windowId: 'A', viewId: 'A1' });
  expect(sessionViewLocation(windows, 'A', key('z'))).toEqual({ windowId: 'B', viewId: 'B1' });
  expect(sessionViewLocation(windows, 'A', key('none'))).toBeUndefined();
});
