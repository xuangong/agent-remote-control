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
