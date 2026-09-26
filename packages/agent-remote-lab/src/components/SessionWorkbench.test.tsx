import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { SessionWorkbench } from './SessionWorkbench.js';
import { LabWorkbench } from './LabWorkbench.js';

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
