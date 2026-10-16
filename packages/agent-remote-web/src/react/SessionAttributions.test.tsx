import { act, useEffect, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { render, rerender, unmount } from '../test/setup.js';
import type { SessionDescription } from '../session-description.js';
import { SessionAttributions, type SessionAttributionsProps } from './SessionAttributions.js';

const description: SessionDescription = {
  identity: { hostId: 'host-a', providerId: 'codex', nativeSessionId: 'task' },
  attributions: [
    { id: 'role', kind: 'role', label: 'Role', value: 'TPM' },
    { id: 'main', kind: 'main', label: 'Main', value: 'Project A', detail: 'Mac mini',
      target: { kind: 'session', hostId: 'host-a', providerId: 'codex', nativeSessionId: 'main' } },
  ],
};

function Example({ children, ...props }: Omit<SessionAttributionsProps, 'children'> & { children?: ReactNode }) {
  return <SessionAttributions {...props}>{({ toggle, details }) => <section>
    <header><h2>Delivery follow-up</h2>{toggle}</header>{details}{children}
  </section>}</SessionAttributions>;
}

async function expand(container: HTMLElement): Promise<HTMLButtonElement> {
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Show session attributions"]')!;
  expect(toggle).not.toBeNull();
  await act(async () => toggle.click());
  return toggle;
}

it('defaults to the compact title and explicitly reveals an accessible property table', async () => {
  const container = await render(<Example description={description} />);
  expect(container.querySelector('table')).toBeNull();
  const toggle = await expand(container);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.getAttribute('aria-label')).toBe('Hide session attributions');
  const region = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  expect(region.querySelector('table')?.getAttribute('aria-label')).toBe('Session attributions');
  expect([...region.querySelectorAll('th[scope="row"]')].map(row => row.textContent)).toEqual(['Role', 'Main']);
  expect(region.textContent).toContain('Project A');
  expect(region.textContent).toContain('Mac mini');
  expect(region.querySelector('button')).toBeNull();
  await act(async () => toggle.click());
  expect(container.querySelector('table')).toBeNull();
}, 5000);

it('keeps disclosure local to each rendered view and preserves mounted conversation content', async () => {
  const mounted = vi.fn(), disposed = vi.fn();
  function Conversation() { useEffect(() => { mounted(); return disposed; }, []); return <textarea defaultValue="Keep my draft" />; }
  const container = await render(<><Example description={description}><Conversation /></Example><Example description={description} /></>);
  const input = container.querySelector('textarea');
  await expand(container);
  expect(container.querySelectorAll('table')).toHaveLength(1);
  expect(container.querySelectorAll('[aria-expanded="false"]')).toHaveLength(1);
  expect(container.querySelector('textarea')).toBe(input);
  expect(input?.value).toBe('Keep my draft');
  expect(mounted).toHaveBeenCalledOnce();
  expect(disposed).not.toHaveBeenCalled();
}, 5000);

it('updates descriptions in place and renders unfamiliar relationship kinds without interpretation', async () => {
  const container = await render(<Example description={description} />);
  await expand(container);
  const longValue = 'A project with a complete readable name '.repeat(12);
  await rerender(container, <Example description={{ ...description, attributions: [{ id: 'custom', kind: 'extension:review', label: 'Reviewed for', value: longValue }] }} />);
  expect(container.querySelector('th')?.textContent).toBe('Reviewed for');
  expect(container.querySelector('td')?.textContent).toBe(longValue);
  expect(container.textContent).not.toContain('Project A');
  await rerender(container, <Example description={{ ...description, attributions: [] }} />);
  expect(container.querySelector('table')).toBeNull();
  expect(container.querySelector('button')).toBeNull();
}, 5000);

it('passes the actual attribution to navigation and presents pending and failure feedback inline', async () => {
  let reject!: (reason: Error) => void;
  const onNavigate = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const container = await render(<Example description={description} onNavigate={onNavigate} />);
  await expand(container);
  const target = container.querySelector<HTMLButtonElement>('td button')!;
  await act(async () => target.click());
  expect(onNavigate).toHaveBeenCalledWith(description.attributions[1]);
  expect(target.disabled).toBe(true);
  expect(target.getAttribute('aria-busy')).toBe('true');
  expect(container.querySelector('td [role="status"]')?.textContent).toBe('Opening…');
  await act(async () => reject(new Error('Host is offline')));
  expect(container.querySelector('td [role="alert"]')?.textContent).toBe('Host is offline');
  expect(target.disabled).toBe(false);
  expect(container.querySelector('h2')?.textContent).toBe('Delivery follow-up');
}, 5000);

it('does not show a late navigation failure on a replaced target or newly bound session', async () => {
  const failures: Array<(reason: Error) => void> = [];
  const onNavigate = vi.fn(() => new Promise<void>((_resolve, reject) => failures.push(reject)));
  const container = await render(<Example description={description} onNavigate={onNavigate} />);
  await expand(container);
  await act(async () => container.querySelector<HTMLButtonElement>('td button')!.click());
  const replacement: SessionDescription = { ...description, attributions: [{ ...description.attributions[1]!, value: 'Project B',
    target: { kind: 'session', hostId: 'host-b', providerId: 'codex', nativeSessionId: 'main' } }] };
  await rerender(container, <Example description={replacement} onNavigate={onNavigate} />);
  await act(async () => failures[0]!(new Error('Old host is offline')));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('td button')!.click());
  await rerender(container, <Example description={{ ...replacement, identity: { ...description.identity, nativeSessionId: 'another-task' } }} onNavigate={onNavigate} />);
  await act(async () => failures[1]!(new Error('Previous session failed')));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector<HTMLButtonElement>('td button')?.disabled).toBe(false);
}, 5000);

it('clears failure feedback when a retry succeeds and keeps the disclosure open', async () => {
  let resolve!: () => void;
  const onNavigate = vi.fn()
    .mockRejectedValueOnce(new Error('Temporarily unavailable'))
    .mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const container = await render(<Example description={description} onNavigate={onNavigate} />);
  await expand(container);
  const target = container.querySelector<HTMLButtonElement>('td button')!;
  await act(async () => target.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Temporarily unavailable');
  await act(async () => target.click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => resolve());
  expect(target.disabled).toBe(false);
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelector('[aria-label="Hide session attributions"]')).not.toBeNull();
}, 5000);

it('keeps only the latest navigation result and handles sync errors and unmounting', async () => {
  const failures: Array<(reason: Error) => void> = [];
  const multi: SessionDescription = { ...description, attributions: [description.attributions[1]!, {
    id: 'team', kind: 'team', label: 'Team', value: 'Release verification', target: { kind: 'group', groupType: 'team', groupId: 'release' },
  }] };
  const onNavigate = vi.fn(() => new Promise<void>((_resolve, reject) => failures.push(reject)));
  const container = await render(<Example description={multi} onNavigate={onNavigate} />);
  await expand(container);
  await act(async () => container.querySelectorAll<HTMLButtonElement>('td button')[0]!.click());
  await act(async () => container.querySelectorAll<HTMLButtonElement>('td button')[1]!.click());
  await act(async () => failures[0]!(new Error('Outdated failure')));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => failures[1]!(new Error('Team unavailable')));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Team unavailable');
  await rerender(container, <Example description={multi} onNavigate={() => { throw 'Unavailable'; }} />);
  await act(async () => container.querySelector<HTMLButtonElement>('td button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The related session could not be opened. Try again.');
  await rerender(container, <Example description={multi} onNavigate={onNavigate} />);
  await act(async () => container.querySelector<HTMLButtonElement>('td button')!.click());
  await unmount(container);
  await act(async () => failures[2]!(new Error('After unmount')));
}, 5000);
