import { act, useMemo, useState } from 'react';
import { expect, it } from 'vitest';
import { useSessionEntries } from './useSessionEntries.js';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { sessionKey } from '../session-tree.js';

it('retains native child titles across child selection and opened-session updates', async () => {
  const opened = [
    { agentId: 'parent', providerId: 'codex', nativeSessionId: 'parent', title: 'Parent' },
    { agentId: 'child', providerId: 'codex', nativeSessionId: 'child', parentNativeSessionId: 'parent', title: 'Bohr' },
    { agentId: 'sibling', providerId: 'codex', nativeSessionId: 'sibling', parentNativeSessionId: 'parent', title: 'Wegener' },
  ];
  function Harness() {
    const [active, setActive] = useState('parent');
    const [saved, setSaved] = useState(opened);
    const state = useMemo(() => ({ ...replicaState, agent: { ...replicaState.agent!, id: active, providerId: 'codex', runtimeInfo: {
      providerId: 'codex', sessionId: active, status: 'idle' as const,
      childSessions: active === 'parent' ? ['child', 'sibling'].map(id => ({ nativeSessionId: id, title: `/root/${id}`,
        createdAt: '2026-09-16T00:00:00Z', status: 'idle' as const, observation: 'live' as const })) : [],
    } } }), [active]);
    const entries = useSessionEntries(saved, state);
    return <><button onClick={() => setActive('child')}>Open child</button>
      <button onClick={() => setSaved(opened.map(item => ({ ...item, title: item.agentId === 'parent' ? 'Renamed parent' : item.title })))}>Update opened</button>
      <ul>{entries.map(item => <li key={item.nativeSessionId} data-session={item.nativeSessionId}>{item.title}</li>)}</ul></>;
  }
  const container = await render(<Harness />);
  const title = (id: string) => container.querySelector(`[data-session="${id}"]`)?.textContent;
  expect(title('child')).toBe('/root/child');
  await act(async () => container.querySelectorAll('button')[0]!.click());
  expect(title('child')).toBe('/root/child');
  expect(title('sibling')).toBe('/root/sibling');
  await act(async () => container.querySelectorAll('button')[1]!.click());
  expect(title('child')).toBe('/root/child');
  expect(title('sibling')).toBe('/root/sibling');
  expect(title('parent')).toBe('Renamed parent');
});

it('keeps a confirmed child rename after child navigation and a stale parent snapshot', async () => {
  const opened = [
    { hostId: 'host', agentId: 'parent', providerId: 'codex', nativeSessionId: 'parent', title: 'Parent' },
    { hostId: 'host', agentId: 'child', providerId: 'codex', nativeSessionId: 'child', parentNativeSessionId: 'parent', title: 'Child' },
  ];
  const childKey = sessionKey(opened[1]!);
  function Harness() {
    const [active, setActive] = useState('parent');
    const [revision, setRevision] = useState(1);
    const [confirmedTitles, setConfirmedTitles] = useState<ReadonlyMap<string, string>>(new Map());
    const state = useMemo(() => ({ ...replicaState, agent: { ...replicaState.agent!, id: active, providerId: 'codex', runtimeInfo: {
      providerId: 'codex', sessionId: active, status: 'idle' as const,
      childSessions: active === 'parent' ? ['child', 'sibling'].map(id => ({ nativeSessionId: id,
        title: id === 'child' ? '/root/child' : `Sibling ${revision}`, createdAt: '2026-09-16T00:00:00Z',
        status: 'idle' as const, observation: 'live' as const })) : [],
    } } }), [active, revision]);
    const entries = useSessionEntries(opened, state, confirmedTitles);
    return <><button onClick={() => setActive('child')}>Open child</button>
      <button onClick={() => setConfirmedTitles(new Map([[childKey, 'Renamed child']]))}>Confirm rename</button>
      <button onClick={() => { setActive('parent'); setRevision(value => value + 1); }}>Receive parent snapshot</button>
      <button onClick={() => setConfirmedTitles(new Map([[childKey, 'Newer confirmed title']]))}>Receive next rename</button>
      <ul>{entries.map(item => <li key={item.nativeSessionId} data-session={item.nativeSessionId}>{item.title}</li>)}</ul></>;
  }
  const container = await render(<Harness />);
  const title = (id: string) => container.querySelector(`[data-session="${id}"]`)?.textContent;
  const click = async (index: number) => act(async () => container.querySelectorAll('button')[index]!.click());
  expect(title('child')).toBe('/root/child');
  await click(0);
  await click(1);
  expect(title('child')).toBe('Renamed child');
  await click(2);
  expect(title('child')).toBe('Renamed child');
  expect(title('sibling')).toBe('Sibling 2');
  await click(0);
  expect(title('child')).toBe('Renamed child');
  await click(3);
  expect(title('child')).toBe('Newer confirmed title');
});

it('scopes confirmed titles by Host, Provider, and native session identity', async () => {
  const opened = [
    { hostId: 'host', agentId: 'primary', providerId: 'codex', nativeSessionId: 'same-id', title: 'Original' },
    { hostId: 'other', agentId: 'other-host', providerId: 'codex', nativeSessionId: 'same-id', title: 'Other Host' },
    { hostId: 'host', agentId: 'other-provider', providerId: 'claude', nativeSessionId: 'same-id', title: 'Other Provider' },
  ];
  const confirmedTitles = new Map([[sessionKey(opened[0]!), 'Confirmed title']]);
  function Harness() {
    return <>{useSessionEntries(opened, undefined, confirmedTitles).map(item => <span key={item.agentId} data-agent={item.agentId}>{item.title}</span>)}</>;
  }
  const container = await render(<Harness />);
  expect(container.querySelector('[data-agent="primary"]')?.textContent).toBe('Confirmed title');
  expect(container.querySelector('[data-agent="other-host"]')?.textContent).toBe('Other Host');
  expect(container.querySelector('[data-agent="other-provider"]')?.textContent).toBe('Other Provider');
});
