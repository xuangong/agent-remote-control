import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInteractionRequest } from '@orchardworks/agent-remote-protocol';

import { render, rerender } from '../test/setup.js';
import { InteractionPanel } from './InteractionPanel.js';
import type { QuestionDraft } from './interactions/QuestionCard.js';

const request: Extract<AgentInteractionRequest, { kind: 'question' }> = {
  kind: 'question', requestId: 'choose-runtime', questions: [
    { questionId: 'runtime', header: 'Choice', prompt: 'Choose a runtime', required: true, selection: 'single', options: [{ value: 'web', label: 'Web' }], allowCustomText: true, allowDismiss: false },
    { questionId: 'tools', header: 'Choice', prompt: 'Choose tools', required: true, selection: 'multiple', options: [{ value: 'a,b', label: 'Build' }, { value: 'test', label: 'Test' }], allowCustomText: true, allowDismiss: false },
    { questionId: 'notes', header: 'Notes', prompt: 'Any notes?', required: false, selection: 'single', options: [], allowCustomText: true, allowDismiss: false },
  ],
};

describe('InteractionPanel', () => {
  it('advances single choice, keeps multiple choices together, and submits stable question and option identities', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const container = await render(<InteractionPanel request={request} onResponse={respond} />);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    await act(async () => container.querySelector<HTMLInputElement>('input[value="web"]')!.click());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Choice');
    expect(container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('Choose tools');
    await act(async () => container.querySelector<HTMLInputElement>('input[value="a,b"]')!.click());
    await act(async () => container.querySelector<HTMLInputElement>('input[value="test"]')!.click());
    expect(container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('Choose tools');
    await act(async () => button(container, 'Next').click());
    await type(container.querySelector<HTMLInputElement>('input[name="notes-custom"]')!, 'Keep exact values');
    await act(async () => button(container, 'Submit response').click());
    expect(respond).toHaveBeenCalledWith('choose-runtime', {
      kind: 'question', answers: [
        { questionId: 'runtime', selectedValues: ['web'] },
        { questionId: 'tools', selectedValues: ['a,b', 'test'] },
        { questionId: 'notes', selectedValues: [], customText: 'Keep exact values' },
      ],
    });
    expect(container.querySelectorAll('[role="tab"][data-answered="true"]')).toHaveLength(3);
    expect(button(container, 'Submitting…').disabled).toBe(true);
  });

  it('restores a host-owned draft after the interaction component is remounted', async () => {
    function Host({ shown }: { shown: boolean }) {
      const [draft, setDraft] = useState<QuestionDraft>({ answers: {} });
      return shown ? <InteractionPanel request={request} onResponse={async () => undefined} questionDraft={draft} onQuestionDraftChange={setDraft} /> : null;
    }
    const container = await render(<Host shown />);
    await type(container.querySelector<HTMLInputElement>('input[name="runtime-custom"]')!, 'Custom runtime');
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
    await act(async () => container.querySelector<HTMLInputElement>('input[value="a,b"]')!.click());
    await rerender(container, <Host shown={false} />);
    await rerender(container, <Host shown />);
    expect(container.querySelector<HTMLInputElement>('input[name="runtime-custom"]')?.value).toBe('Custom runtime');
    expect(container.querySelector<HTMLInputElement>('input[value="a,b"]')?.checked).toBe(true);
    expect(container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('Choose tools');
  });

  it('returns to the missing required question without sending an incomplete response', async () => {
    const respond = vi.fn();
    const container = await render(<InteractionPanel request={request} onResponse={respond} />);
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[2]!.click());
    await act(async () => button(container, 'Submit response').click());
    expect(respond).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('requires an answer');
    expect(container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('Choose a runtime');
  });

  it('sends plan revision feedback only with rejection and keeps it after a failed submission', async () => {
    const respond = vi.fn().mockRejectedValueOnce(new Error('Try again')).mockResolvedValue(undefined);
    const plan: AgentInteractionRequest = { kind: 'plan_approval', requestId: 'plan', plan: 'Review **all** steps', allowedActions: ['approve', 'reject'] };
    const container = await render(<InteractionPanel request={plan} onResponse={respond} />);
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Include a rollback');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-action="reject"]')!.click());
    expect(respond).toHaveBeenLastCalledWith('plan', { kind: 'plan_approval', action: 'reject', feedback: 'Include a rollback' });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Try again');
    expect(container.querySelector('textarea')?.value).toBe('Include a rollback');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-action="approve"]')!.click());
    expect(respond).toHaveBeenLastCalledWith('plan', { kind: 'plan_approval', action: 'approve' });
  });
});

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === text);
  if (!result) throw new Error(`Button not found: ${text}`);
  return result;
}

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
