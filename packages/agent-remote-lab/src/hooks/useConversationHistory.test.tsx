import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { useConversationHistory } from './useConversationHistory.js';
import type { SessionEntry } from '../session-tree.js';

const parent: SessionEntry = { hostId: 'local', providerId: 'codex', nativeSessionId: 'parent', title: 'Parent' };
const child = { ...parent, nativeSessionId: 'child', parentNativeSessionId: 'parent', title: 'Child' };
const sibling = { ...child, nativeSessionId: 'sibling', title: 'Sibling' };
const other = { ...parent, nativeSessionId: 'other', title: 'Other root' };
const known = [parent, child, sibling, other];
afterEach(() => { window.history.replaceState(null, '', '/'); });

async function setup(open?: (session: SessionEntry) => Promise<boolean>) {
  function Fixture() {
    const [current, setCurrent] = useState(() => known.find(session => session.nativeSessionId === new URLSearchParams(location.search).get('session')) ?? parent);
    const navigation = useConversationHistory(current, known, async target => {
      if (open && !await open(target)) return false;
      setCurrent(target);
      return true;
    });
    return <><output>{current.nativeSessionId}</output>
      {known.map(target => <button key={target.nativeSessionId} onClick={() => setCurrent(target)}>{target.title}</button>)}
      <button disabled={!navigation.canBack} onClick={navigation.back}>Back</button>
      <button disabled={!navigation.canForward} onClick={navigation.forward}>Forward</button>
    </>;
  }
  function Host() {
    const [revision, setRevision] = useState(0);
    return <><button onClick={() => setRevision(value => value + 1)}>Reload</button><Fixture key={revision} /></>;
  }
  const container = await render(<Host />);
  const click = async (label: string) => {
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === label)!.click());
    await settle();
  };
  return { container, click };
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); }

it('visits ordinary and explicit history for the same native session independently', async () => {
  const opened: Array<unknown> = [];
  function Fixture() {
    const [intent, setIntent] = useState<'history'>();
    const navigation = useConversationHistory(parent, known, async (session, nextIntent, keepOriginal) => {
      opened.push([session.nativeSessionId, nextIntent, keepOriginal]); setIntent(nextIntent); return true;
    }, intent, true);
    return <><button onClick={() => setIntent('history')}>History</button><button onClick={navigation.back}>Back</button><button onClick={navigation.forward}>Forward</button></>;
  }
  const container = await render(<Fixture />);
  await act(async () => container.querySelector('button')!.click());
  expect(new URLSearchParams(location.search).get('intent')).toBe('history');
  await act(async () => container.querySelectorAll('button')[1]!.click()); await settle();
  expect(opened).toEqual([['parent', undefined, true]]);
  expect(new URLSearchParams(location.search).has('intent')).toBe(false);
  expect(new URLSearchParams(location.search).get('keepOriginal')).toBe('1');
  await act(async () => container.querySelectorAll('button')[2]!.click()); await settle();
  expect(opened[1]).toEqual(['parent', 'history', true]);
});

it('drops the forward branch after a new visit and bounds controls to the current native family', async () => {
  const f = await setup();
  await f.click('Child');
  await f.click('Sibling');
  await f.click('Back');
  expect(f.container.querySelector('output')!.textContent).toBe('child');
  await f.click('Parent');
  expect([...f.container.querySelectorAll('button')].find(button => button.textContent === 'Forward')!.disabled).toBe(true);
  await f.click('Other root');
  expect([...f.container.querySelectorAll('button')].find(button => button.textContent === 'Back')!.disabled).toBe(true);
});

it('restores the browser position after failed attachment so the next traversal remains usable', async () => {
  const open = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const f = await setup(open);
  await f.click('Child');
  await f.click('Sibling');
  await f.click('Back');
  await settle();
  expect(f.container.querySelector('output')!.textContent).toBe('sibling');
  expect(new URLSearchParams(location.search).get('session')).toBe('sibling');
  await f.click('Back');
  expect(f.container.querySelector('output')!.textContent).toBe('child');
  await f.click('Forward');
  expect(f.container.querySelector('output')!.textContent).toBe('sibling');
});

it('finishes at the latest browser destination when another traversal arrives during attachment', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const open = vi.fn().mockImplementationOnce(async () => { await pending; return true; }).mockResolvedValue(true);
  const f = await setup(open);
  await f.click('Child');
  await f.click('Sibling');
  await act(async () => window.history.back());
  await settle();
  await act(async () => window.history.back());
  await settle();
  await act(async () => release());
  await settle();
  expect(open.mock.calls.map(([session]) => session.nativeSessionId)).toEqual(['child', 'parent']);
  expect(f.container.querySelector('output')!.textContent).toBe('parent');
  expect(new URLSearchParams(location.search).get('session')).toBe('parent');
  await f.click('Forward');
  expect(f.container.querySelector('output')!.textContent).toBe('child');
});

it('restores the same browser history after remounting a visited conversation', async () => {
  const f = await setup();
  await f.click('Child');
  await f.click('Sibling');
  await f.click('Reload');
  expect(f.container.querySelector('output')!.textContent).toBe('sibling');
  await f.click('Back');
  expect(f.container.querySelector('output')!.textContent).toBe('child');
  await f.click('Back');
  expect(f.container.querySelector('output')!.textContent).toBe('parent');
  await f.click('Forward');
  expect(f.container.querySelector('output')!.textContent).toBe('child');
});

it('retains the latest layout for each browser visit and supplies it on back and forward', async () => {
  let select!: (session: SessionEntry) => void, focus!: (id: string) => void;
  const restored: string[] = [];
  function Fixture() {
    const [session, setSession] = useState(parent); select = setSession;
    const [focused, setFocused] = useState('parent'); focus = setFocused;
    useConversationHistory(session, known, async (target, _intent, _keep, layout) => {
      restored.push(layout?.focus ?? 'missing'); setSession(target); setFocused(layout?.focus ?? 'missing'); return true;
    }, undefined, undefined, { scope: 'history-layout', layout: { primarySlot: session.nativeSessionId, selections: {}, focus: focused } });
    return null;
  }
  await render(<Fixture />);
  await act(async () => focus('expanded-child'));
  await act(async () => select(child));
  await act(async () => focus('expanded-grandchild'));
  await act(async () => window.history.back()); await settle();
  expect(restored).toEqual(['expanded-child']);
  await act(async () => window.history.forward()); await settle();
  expect(restored).toEqual(['expanded-child', 'expanded-grandchild']);
});

it('bounds detailed layouts to the ten most recently changed visits', async () => {
  let select!: (session: SessionEntry) => void;
  function Fixture() {
    const [session, setSession] = useState(parent); select = setSession;
    useConversationHistory(session, known, async () => true, undefined, undefined,
      { scope: 'bounded', layout: { primarySlot: session.nativeSessionId, selections: {} } });
    return null;
  }
  await render(<Fixture />);
  for (let i = 0; i < 15; i++) await act(async () => select({ ...parent, nativeSessionId: `visit-${i}` }));
  const visits = JSON.parse(sessionStorage.getItem('agent-remote-conversation-history')!);
  expect(visits.filter((visit: { layout?: unknown }) => visit.layout)).toHaveLength(10);
  expect(visits.slice(-10).every((visit: { layout?: unknown }) => !!visit.layout)).toBe(true);
});

it('does not restore a visit from another workspace or a malformed layout', async () => {
  sessionStorage.setItem('agent-remote-conversation-history', JSON.stringify([{ id: 'foreign', root: 'main', session: parent, scope: 'other', layout: { primarySlot: 'parent', selections: {} } }]));
  window.history.replaceState({ agentRemoteVisit: 'foreign' }, '', '/');
  let back = true;
  function Fixture() { back = useConversationHistory(parent, known, async () => true, undefined, undefined, { scope: 'own' }).canBack; return null; }
  await render(<Fixture />);
  expect(back).toBe(false);
  expect(JSON.parse(sessionStorage.getItem('agent-remote-conversation-history')!)[0].scope).toBe('own');
});
