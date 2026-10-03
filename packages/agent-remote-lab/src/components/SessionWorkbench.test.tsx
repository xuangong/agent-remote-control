import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { SessionWorkbench } from './SessionWorkbench.js';
import { LabWorkbench } from './LabWorkbench.js';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';

it('renders the same conversation and composer through product and standalone composition', async () => {
  const props = { state: replicaState, sessionStatus: 'ready' as const, actions: {}, messageDraft: 'Keep my draft' };
  const standalone = await render(<SessionWorkbench {...props} />);
  const product = await render(<LabWorkbench {...props} />);
  expect(standalone.querySelector('[aria-label="Agent timeline"]')).not.toBeNull();
  expect(standalone.querySelector('[aria-label="Agent timeline"]')!.textContent).toBe(product.querySelector('[aria-label="Agent timeline"]')!.textContent);
  expect(standalone.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!.value).toBe('Keep my draft');
  expect(product.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!.value).toBe('Keep my draft');
  expect(standalone.querySelector('a[href*="auth"]')).toBeNull();
});

it('keeps recordings read-only even when mutation and takeover actions are supplied', async () => {
  const sendMessage = vi.fn(), takeControl = vi.fn();
  const container = await render(<SessionWorkbench state={replicaState} sessionStatus="ready" readOnly actions={{ sendMessage, takeControl }} messageDraft="Recorded text" />);
  const submit = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]');
  if (submit) { expect(submit.disabled).toBe(true); await act(async () => submit.click()); }
  expect(container.querySelector('[aria-label="Take control"]')).toBeNull();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(takeControl).not.toHaveBeenCalled();
});


it('renders authoritative idle activity even when retained turn metadata is present', async () => {
  const state = { ...replicaState, agent: { ...replicaState.agent!, status: 'idle' as const,
    activeTurn: { turnId: 'retained', startedAt: '2026-09-26T00:00:00Z' } } };
  const container = await render(<SessionWorkbench state={state} sessionStatus="ready" actions={{}} />);
  expect(container.querySelector('.lab-conversation-status')!.textContent).toBe('Ready');
  expect(container.querySelector('[data-testid="agent-activity-label"]')!.textContent).toBe('Ready');
  expect(container.querySelector('[data-testid="turn-elapsed"]')).toBeNull();
});

it('does not open session search from an image portal but keeps the timeline shortcut', async () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.open = true; } },
    close: { configurable: true, value() { this.open = false; } },
  });
  const binding = { resourceId: 'image', locator: './image.png', status: 'available' as const };
  const image = { status: 'available' as const, mediaType: 'image/png', byteLength: 1, sha256: 'image', contentBase64: 'AA==' };
  const state: AgentReplicaState = { ...replicaState, resources: { image },
    timeline: { ...replicaState.timeline, entries: [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-09-30T00:00:00Z',
    sourceSeqRanges: [], collapsed: [], resources: [binding], item: { type: 'assistant_message', text: '![Screenshot](./image.png)' },
  }] } };
  const container = await render(<SessionWorkbench state={state} sessionStatus="ready" actions={{
    resolveResource: async () => binding, requestResource: async () => image,
  }} />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open image: Screenshot"]')!.click());
  const dialog = document.querySelector('dialog[aria-label="Image preview"]')!;
  expect(dialog).not.toBeNull();
  const search = container.querySelector<HTMLButtonElement>('[aria-label="Search this session"]')!;
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })));
  expect(search.hidden).toBe(false);
  await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')!.click());
  await act(async () => container.querySelector('[data-testid="timeline"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })));
  expect(search.hidden).toBe(true);
});

it('reopens a collapsed runtime notice group when the same search result is requested again', async () => {
  const state: AgentReplicaState = { ...replicaState, timeline: { ...replicaState.timeline, hasOlder: false,
    entries: ['First runtime notice', 'Second runtime notice'].map((message, index) => ({
      providerId: 'recorded', seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-10-03T00:00:00Z',
      sourceSeqRanges: [], collapsed: [], resources: [], item: { type: 'error', message },
    })),
  } };
  const container = await render(<SessionWorkbench state={state} sessionStatus="ready" actions={{}} />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Search this session"]')!.click());
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search session history"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Second runtime');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const scope = container.querySelector<HTMLSelectElement>('[aria-label="Search scope"]')!;
    scope.value = 'all'; scope.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const next = container.querySelector<HTMLButtonElement>('[aria-label="Next search result"]')!;
  expect(next.disabled).toBe(false);
  await act(async () => next.click());
  const toggle = container.querySelector<HTMLButtonElement>('.agent-notice-toggle')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const target = '.agent-timeline-entry[data-entry-key="epoch-1:recorded:2:error"]';
  expect(container.querySelector(target)?.getAttribute('data-inspected')).toBe('true');
  await act(async () => toggle.click());
  expect(container.querySelector(target)).toBeNull();
  await act(async () => next.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector(target)?.textContent).toContain('Second runtime notice');
});
