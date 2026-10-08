import { act, useState } from 'react';
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { ChatSessionManager } from './ChatSessionManager.js';
import type { SessionEntry } from '../session-tree.js';

it('exposes working subagents in the collapsed family menu and updates as work finishes', async () => {
  const parent: SessionEntry = { providerId: 'codex', nativeSessionId: 'parent', title: 'Parent', status: 'running' };
  const child: SessionEntry = { ...parent, nativeSessionId: 'child', parentNativeSessionId: 'parent', title: '/root/review' };
  const sibling: SessionEntry = { ...child, nativeSessionId: 'sibling', title: '/root/tests', status: 'idle' };
  const foreign: SessionEntry = { ...child, nativeSessionId: 'foreign', parentNativeSessionId: 'other-parent', title: 'Other family' };
  const entries = [parent, child, sibling, foreign];
  const opened: string[] = [];
  const onOpen = (entry: SessionEntry) => { opened.push(entry.nativeSessionId); };
  let update!: (value: { current: SessionEntry; entries: SessionEntry[] }) => void;
  function Harness() {
    const [value, setValue] = useState({ current: parent, entries });
    update = setValue;
    return <ChatSessionManager {...value} busy={false} onOpen={onOpen} />;
  }
  const container = await render(<Harness />);
  const heading = () => container.querySelector<HTMLButtonElement>('.lab-chat-sessions-heading')!;
  expect(heading().getAttribute('aria-expanded')).toBe('false');
  expect(heading().textContent).toContain('1 working');
  await act(async () => heading().click());
  const rows = [...container.querySelectorAll<HTMLButtonElement>('.lab-chat-session-row')];
  expect(rows).toHaveLength(3);
  expect(rows.find(row => row.textContent?.includes('/root/review'))?.textContent).toContain('Working');
  await act(async () => rows.find(row => row.textContent?.includes('/root/review'))!.click());
  expect(opened).toEqual(['child']);
  await act(async () => update({ current: child, entries }));
  expect(heading().textContent).toContain('1 working');
  await act(async () => heading().click());
  expect(container.querySelectorAll('.lab-chat-session-row')).toHaveLength(3);
  expect(container.textContent).toContain('/root/tests');
  await act(async () => update({ current: child, entries: entries.map(entry => entry.nativeSessionId === 'child' ? { ...entry, status: 'idle' } : entry) }));
  expect(heading().textContent).not.toContain('working');
  expect(heading().getAttribute('aria-expanded')).toBe('true');
});

it('keeps Escape and focus inside the active family menu without dismissing other composed views', async () => {
  const parent: SessionEntry = { providerId: 'codex', nativeSessionId: 'parent', title: 'Parent', status: 'idle' };
  const child: SessionEntry = { ...parent, nativeSessionId: 'child', parentNativeSessionId: 'parent', title: 'Child' };
  const props = { current: parent, entries: [parent, child], busy: false, onOpen: () => {} };
  const container = await render(<><ChatSessionManager {...props} /><ChatSessionManager {...props} /><button type="button">Outer action</button></>);
  const headings = container.querySelectorAll<HTMLButtonElement>('.lab-chat-sessions-heading');
  for (const heading of headings) await act(async () => { heading.focus(); heading.click(); });
  const childRow = container.querySelectorAll<HTMLButtonElement>('.lab-chat-sessions')[1]!.querySelector<HTMLButtonElement>('.lab-chat-session-row:not(:disabled)')!;
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => { childRow.focus(); childRow.dispatchEvent(escape); });
  expect([...headings].map(heading => heading.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
  expect(document.activeElement).toBe(headings[1]);
  expect(escape.defaultPrevented).toBe(true);

  const outer = container.querySelector<HTMLButtonElement>(':scope > button')!;
  const outerEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => { outer.focus(); outer.dispatchEvent(outerEscape); });
  expect(headings[0]!.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(outer);
  expect(outerEscape.defaultPrevented).toBe(false);
});
