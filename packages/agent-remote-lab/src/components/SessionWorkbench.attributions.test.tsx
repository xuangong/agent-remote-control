import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { SessionDescription } from '@orchardworks/agent-remote-web';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { SessionWorkbench } from './SessionWorkbench.js';

const description: SessionDescription = {
  identity: { hostId: 'host-a', providerId: 'codex', nativeSessionId: 'child' },
  attributions: [{ id: 'main', kind: 'main', label: 'Main', value: 'Project A',
    target: { kind: 'session', hostId: 'host-a', providerId: 'codex', nativeSessionId: 'main' } }],
};

it('expands attributions without remounting the conversation, replacing its draft or changing title actions', async () => {
  const rename = vi.fn();
  const container = await render(<SessionWorkbench sessionDescription={description} state={replicaState} sessionStatus="ready" actions={{}}
    messageDraft="Keep editing here" conversationPath={<h2 onDoubleClick={rename}>Delivery follow-up</h2>} />);
  const timeline = container.querySelector('[data-testid="timeline"]');
  const draft = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]');
  const title = container.querySelector('h2')!;
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Show session attributions"]')!;
  expect(toggle.closest('.lab-session-heading-trailing')).not.toBeNull();
  expect(container.querySelector('table[aria-label="Session attributions"]')).toBeNull();
  await act(async () => toggle.click());
  expect(container.querySelector('table[aria-label="Session attributions"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="timeline"]')).toBe(timeline);
  expect(container.querySelector('[data-testid="prompt-input"]')).toBe(draft);
  expect(draft?.value).toBe('Keep editing here');
  expect(container.querySelector('h2')).toBe(title);
  await act(async () => title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  expect(rename).toHaveBeenCalledOnce();
  await act(async () => toggle.click());
  expect(container.querySelector('[data-testid="timeline"]')).toBe(timeline);
  expect(container.querySelector('[data-testid="prompt-input"]')).toBe(draft);
}, 5000);

it('uses existing toolbar controls and only reveals the normal heading region on expansion', async () => {
  const navigate = vi.fn(async () => {});
  const container = await render(<SessionWorkbench headingMode="toolbar" sessionDescription={description} onNavigateAttribution={navigate}
    state={replicaState} sessionStatus="ready" actions={{}} />);
  const group = container.querySelector<HTMLElement>('.lab-workbench-heading-group')!;
  const title = container.querySelector<HTMLElement>('.lab-session-heading')!;
  const timeline = container.querySelector('[data-testid="timeline"]');
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Show session attributions"]')!;
  expect(toggle.closest('.lab-timeline-session-tools')).not.toBeNull();
  expect(group.hidden).toBe(true);
  expect(title.hidden).toBe(true);
  await act(async () => toggle.click());
  const table = group.querySelector('table[aria-label="Session attributions"]')!;
  expect(table).not.toBeNull();
  expect(group.hidden).toBe(false);
  expect(title.hidden).toBe(true);
  expect(table.closest('.lab-timeline-tools')).toBeNull();
  expect(container.querySelector('[data-testid="timeline"]')).toBe(timeline);
  await act(async () => table.querySelector<HTMLButtonElement>('td button')!.click());
  expect(navigate).toHaveBeenCalledWith(description.attributions[0]);
  await act(async () => toggle.click());
  expect(group.hidden).toBe(true);
}, 5000);

it('supports relationships before native attachment without inventing an empty panel for ordinary sessions', async () => {
  const opening = await render(<SessionWorkbench sessionDescription={description} sessionStatus="connecting" attachingAgentId="child" actions={{}} />);
  await act(async () => opening.querySelector<HTMLButtonElement>('[aria-label="Show session attributions"]')!.click());
  expect(opening.querySelector('table')?.textContent).toContain('Project A');
  const ordinary = await render(<SessionWorkbench sessionStatus="connecting" actions={{}} />);
  expect(ordinary.querySelector('[aria-label="Show session attributions"]')).toBeNull();
  expect(ordinary.querySelector('table')).toBeNull();
}, 5000);
