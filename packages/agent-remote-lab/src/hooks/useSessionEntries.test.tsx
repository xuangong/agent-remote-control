import { act, useMemo, useState } from 'react';
import { expect, it } from 'vitest';
import { useSessionEntries } from './useSessionEntries.js';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';

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
