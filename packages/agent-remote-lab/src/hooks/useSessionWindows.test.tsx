import { act, useState } from 'react';
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { useSessionWindows, type SessionWindowTarget } from './useSessionWindows.js';

const target = (id: string): SessionWindowTarget => ({ hostId: 'host', providerId: 'fixture', nativeSessionId: id, title: id });
it('restores a close group, gathers missing windows, and ignores a late gather after closing its leader', async () => {
  let windows!: ReturnType<typeof useSessionWindows>, reload!: () => void;
  function Workspace() { windows = useSessionWindows('window-groups'); return <>{windows.entries.map(entry => <span key={entry.target.nativeSessionId}>{entry.target.title}</span>)}</>; }
  function Harness() { const [revision, setRevision] = useState(0); reload = () => setRevision(value => value + 1); return <Workspace key={revision} />; }
  await render(<Harness />);
  const leader = target('leader'), member = target('member'), other = target('other');
  await act(async () => { windows.open([leader, member], leader, 'team'); windows.open([other]); });
  await act(async () => reload());
  expect(windows.entries[0]?.groupId).toBe('team');
  const root = windows.entries[0]!;
  await act(async () => windows.close(member));
  expect(windows.entries.map(entry => entry.target.nativeSessionId)).toEqual(['leader', 'other']);
  await act(async () => windows.gather(root, [leader, member]));
  const opened = windows.entries.find(entry => entry.target.nativeSessionId === 'member')!;
  await act(async () => windows.gather(root, [leader, member]));
  expect(windows.entries.find(entry => entry.target.nativeSessionId === 'member')?.dockRequest).toBe(opened.dockRequest);
  await act(async () => windows.close(leader));
  await act(async () => windows.gather(root, [leader, member]));
  await act(async () => reload());
  expect(windows.entries.map(entry => entry.target.nativeSessionId)).toEqual(['other']);
});
