import { act } from 'react';
import { expect, it } from 'vitest';
import type { AgentChildSession } from '@borgee/agent-remote-protocol';
import { render, rerender } from '../test/setup.js';
import { AgentChildSessionList } from './AgentChildSessionList.js';
const child = (id: string, status: AgentChildSession['status'] = 'idle'): AgentChildSession => ({ nativeSessionId: id, title: `/root/${id}`, createdAt: '2026-09-16T00:00:00Z', status, observation: 'live' });

it('expands nested subagents and opens their identity without changing the parent disclosure', async () => {
  const opened: string[] = [];
  const children = [child('review')];
  const childrenFor = (id: string) => id === 'review' ? [child('evidence', 'running'), { ...child('history'), observation: 'saved_history' as const }] : [];
  const container = await render(<AgentChildSessionList children={children} childrenFor={childrenFor} collapsible onOpenChildSession={item => { opened.push(item.nativeSessionId); }} />);
  const outer = container.querySelector('details')!;
  expect(outer.open).toBe(false);
  expect(outer.querySelector('summary')?.textContent).toContain('1 working');
  await act(async () => outer.querySelector('summary')!.click());
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Expand subagents of /root/review"]')!;
  expect(toggle).not.toBeNull();
  expect(container.querySelector('[data-child-session-id="evidence"]')).toBeNull();
  await act(async () => toggle.click());
  const nested = container.querySelector<HTMLButtonElement>('[data-child-session-id="evidence"]')!;
  expect(nested.textContent).toContain('Working');
  expect(nested.closest('ul')?.parentElement?.getAttribute('data-child-branch')).toBe('review');
  expect(container.textContent).toContain('Saved history');
  await act(async () => nested.click());
  expect(opened).toEqual(['evidence']);
  await rerender(container, <AgentChildSessionList children={children} childrenFor={id => childrenFor(id).map(item => ({ ...item, status: 'idle' }))} collapsible />);
  expect(outer.open).toBe(true);
  expect(container.querySelector('[data-child-session-id="evidence"]')).not.toBeNull();
  expect(outer.querySelector('summary')?.textContent).not.toContain('working');
});

it('bounds cycles in recorded relationships', async () => {
  const container = await render(<AgentChildSessionList children={[child('review')]} childrenFor={() => [child('review')]} />);
  expect(container.querySelectorAll('[data-child-session-id]')).toHaveLength(1);
  expect(container.querySelector('[aria-label="Expand subagents of /root/review"]')).toBeNull();
});

it('shows recorded descendants when runtime metadata is unavailable', async () => {
  const container = await render(<AgentChildSessionList children={[child('review')]} childrenFor={id => id === 'review' ? [{ nativeSessionId: 'recorded', title: '/root/review/recorded' }] : []} />);
  await act(async () => container.querySelector<HTMLButtonElement>('.agent-child-toggle')!.click());
  expect(container.querySelector('[data-child-session-id="recorded"]')?.textContent).toContain('Status unavailable');
  expect(container.querySelector('[data-child-session-id="recorded"]')?.textContent).not.toContain('Ready');
});
