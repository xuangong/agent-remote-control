import { act, useState } from 'react';
import { expect, it } from 'vitest';
import type { SessionSuccessionCurrent, SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import { sessionSuccessionHistory } from '../hooks/useSessionSuccession.js';
import { render } from '../test/setup.js';
import { SessionSuccessionHistory } from './SessionSuccessionHistory.js';

const native = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'recorded', nativeSessionId });
const session = (nativeSessionId: string): SessionEntry => ({ hostId: 'host', providerId: 'recorded', nativeSessionId, title: `Session ${nativeSessionId}` });
function committed(from: string, to: string, revision: number): SessionSuccessionReplay {
  const request = { operationId: `operation-${revision}`, roleId: 'role', expectedRevision: revision - 1, from: native(from) };
  const workspace = { controllerId: 'controller', canonicalCwd: '/project' };
  return { version: 1, from: { hostId: 'host', providerId: 'recorded', nativeSessionId: from }, to: { hostId: 'host', providerId: 'recorded', nativeSessionId: to },
    projection: { version: 1, role: { id: 'role', revision, origin: native('A'), current: native(to), workspace },
      receipt: { ...request, to: native(to), phase: 'committed', committedRevision: revision, startedAt: 'now', updatedAt: 'now',
        prepared: { ...request, to: native(to), workspace, associationRevision: 1, participants: [], capture: { epoch: 'epoch', seq: 1, capturedAt: 'now' } } } } };
}
const chain = [committed('A', 'B', 2), committed('B', 'C', 3)];
const current: SessionSuccessionCurrent = { version: 1, role: chain[1]!.projection.role, locator: chain[1]!.to };
const titles = new Map(['A', 'B', 'C'].map(id => [sessionKey(session(id)), `Session ${id}`]));
function navigation(selected = 'C', intent?: 'history', replays = chain, confirmed: SessionSuccessionCurrent | undefined = current) {
  return sessionSuccessionHistory({ scope: 'scope', replays, current: confirmed, selected: session(selected), intent, titles });
}
function link(view: HTMLElement, title: string): HTMLAnchorElement {
  const result = [...view.querySelectorAll<HTMLAnchorElement>('a')].find(item => item.textContent === title);
  expect(result).toBeDefined(); return result!;
}

it('opens the predecessor with history intent and returns through ordinary current-role navigation', async () => {
  const transitions: Array<{ id: string; intent?: 'history' }> = [];
  function Fixture() {
    const [selected, setSelected] = useState({ id: 'B', intent: undefined as 'history' | undefined });
    const latest = { version: 1 as const, role: chain[0]!.projection.role, locator: chain[0]!.to };
    return <><h1>{selected.id}</h1><SessionSuccessionHistory navigation={navigation(selected.id, selected.intent, chain.slice(0, 1), latest)} onOpen={async (target, intent) => {
      transitions.push({ id: target.nativeSessionId, intent }); setSelected({ id: target.nativeSessionId, intent }); return true;
    }} /></>;
  }
  const view = await render(<Fixture />);
  const past = link(view, 'Session A');
  expect(new URL(past.href).searchParams.get('intent')).toBe('history');
  expect(new URL(past.href).searchParams.get('session')).toBe('A');
  expect(new URL(past.href).searchParams.has('agent')).toBe(false);
  await act(async () => past.click());
  expect(view.querySelector('h1')?.textContent).toBe('A');
  expect(view.textContent).toContain('Continued by Session B');
  const back = link(view, 'Return to current');
  expect(new URL(back.href).searchParams.get('session')).toBe('B');
  expect(new URL(back.href).searchParams.has('intent')).toBe(false);
  await act(async () => back.click());
  expect(view.querySelector('h1')?.textContent).toBe('B');
  expect(transitions).toEqual([{ id: 'A', intent: 'history' }, { id: 'B', intent: undefined }]);
}, 5000);

it('keeps the immediate predecessor compact and reveals older ancestors once in nearest-first order', async () => {
  const view = await render(<SessionSuccessionHistory navigation={navigation()} onOpen={async () => true} />);
  expect(view.querySelector('details')?.open).toBe(false);
  expect(view.querySelector('details')?.textContent).not.toContain('Session B');
  expect([...view.querySelectorAll('a')].map(item => item.textContent)).toEqual(['Session B', 'Session A']);
  expect(view.textContent).not.toContain('Session C');
  await act(async () => view.querySelector('summary')!.click());
  expect(view.querySelector('details')?.open).toBe(true);
  expect(new URL(link(view, 'Session A').href).searchParams.get('intent')).toBe('history');
}, 5000);

it('does not intercept modified history-link clicks so the real URL can open in another tab', async () => {
  const view = await render(<SessionSuccessionHistory navigation={navigation()} onOpen={async () => { throw new Error('Modified click was intercepted'); }} />);
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  let intercepted: boolean | undefined;
  view.addEventListener('click', event => { intercepted = event.defaultPrevented; event.preventDefault(); });
  await act(async () => { link(view, 'Session B').dispatchEvent(event); });
  expect(intercepted).toBe(false);
}, 5000);

it('builds unknown historical identities without inventing an attachment or parent', () => {
  const result = sessionSuccessionHistory({ scope: 'scope', replays: chain, current, selected: session('C') });
  expect(result?.predecessor).toEqual({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'B' });
  expect(result?.ancestors).toEqual([{ hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', title: 'A' }]);
}, 5000);

it.each(['missing-current', 'gap', 'wrong-origin', 'wrong-current', 'unrelated', 'duplicate'] as const)('does not infer history from %s role evidence', async reason => {
  let replays = structuredClone(chain), confirmed: SessionSuccessionCurrent | undefined = structuredClone(current), selected = 'C';
  if (reason === 'missing-current') confirmed = undefined;
  if (reason === 'gap') replays = replays.slice(1);
  if (reason === 'wrong-origin') replays[1]!.projection.role.origin = native('X');
  if (reason === 'wrong-current') confirmed!.role.current = native('D');
  if (reason === 'unrelated') selected = 'X';
  if (reason === 'duplicate') replays.push(replays[1]!);
  const value = sessionSuccessionHistory({ scope: 'scope', replays, current: confirmed, selected: session(selected), titles });
  expect(value).toBeUndefined();
  const view = await render(<SessionSuccessionHistory navigation={value} onOpen={async () => true} />);
  expect(view.querySelector('nav')).toBeNull();
}, 5000);
