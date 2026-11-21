// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { AgentInteractionRequest, AgentTimelineItem } from '@orchardworks/agent-remote-protocol';

import { render } from '../../test/setup.js';
import { TimelineItemRenderer } from '../TimelineItemRenderer.js';
import { openReceipts } from '../../test/interactions.js';

describe('InteractionItem', () => {
  it('renders completed answers by stable question ID with exact option labels and custom text', async () => {
    const item = {
      type: 'interaction',
      request: { kind: 'question', requestId: 'question', questions: [
        { questionId: 'tools', header: 'Choice', prompt: 'Which tools?', required: true, selection: 'multiple', options: [{ value: 'a,b', label: 'Build' }, { value: 'test', label: 'Test' }], allowCustomText: true, allowDismiss: false },
        { questionId: 'runtime', header: 'Choice', prompt: 'Which runtime?', required: true, selection: 'single', options: [{ value: 'web', label: 'Web' }], allowCustomText: false, allowDismiss: false },
      ] },
      response: { kind: 'question', answers: [{ questionId: 'runtime', selectedValues: ['web'] }, { questionId: 'tools', selectedValues: ['a,b', 'test'], customText: 'Keep logs' }] },
    } satisfies AgentTimelineItem;
    const container = await render(<TimelineItemRenderer item={item} />);
    expect(container.querySelector('.agent-receipt-toggle')?.textContent).toContain('Answered');
    await openReceipts(container);
    const answers = container.querySelectorAll('.agent-completed-answer');
    expect(answers[0]?.querySelector('dt')?.textContent).toBe('Choice');
    expect(answers[0]?.textContent).toContain('Build');
    expect(answers[0]?.textContent).toContain('Test');
    expect(answers[0]?.textContent).toContain('Keep logs');
    expect(answers[1]?.textContent).toContain('Web');
    expect(answers[0]?.querySelector('ul')?.closest('[hidden]')).toBeNull();
    expect(answers[0]?.querySelector('.agent-answer-custom')?.closest('[hidden]')).toBeNull();
    expect(container.querySelector('input, textarea')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(2);
  });

  it('discloses original prompts and descriptions without hiding or changing the recorded answers', async () => {
    const container = await render(<TimelineItemRenderer item={{
      type: 'interaction',
      request: { kind: 'question', requestId: 'files', questions: [
        { questionId: 'file', header: 'File relation', prompt: 'How is `fixture.txt` used?', description: 'Keep **all** context.', required: true, selection: 'single', options: [{ value: 'input', label: 'Input file' }], allowCustomText: false, allowDismiss: false },
      ] },
      response: { kind: 'question', answers: [{ questionId: 'file', selectedValues: ['input'] }] },
    }} />);
    await openReceipts(container);
    const toggle = container.querySelector<HTMLButtonElement>('.agent-question-context-toggle')!;
    expect(toggle?.textContent).toContain('Show questions');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(toggle?.getAttribute('aria-controls') ?? '')).not.toBeNull();
    const prompt = container.querySelector<HTMLElement>('.agent-completed-question-context')!;
    expect(prompt?.hidden).toBe(true);
    const answer = container.querySelector('.agent-completed-answer ul');
    expect(answer?.textContent).toBe('Input file');

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('Hide questions');
    expect(prompt.hidden).toBe(false);
    expect(prompt.querySelector('code')?.textContent).toBe('fixture.txt');
    expect(prompt.querySelector('strong')?.textContent).toBe('all');
    expect(answer?.textContent).toBe('Input file');
    await act(async () => toggle.click());
    expect(prompt.hidden).toBe(true);
    expect(answer?.closest('[hidden]')).toBeNull();
  });

  it.each([
    ['approve', 'Plan approved'], ['approve_and_resume', 'Plan approved, carrying on'], ['reject', 'Asked for changes to the plan'],
  ] as const)('says in its own words that a plan was answered with %s', async (action, words) => {
    const container = await render(<TimelineItemRenderer item={{
      type: 'interaction',
      request: { kind: 'plan_approval', requestId: 'plan', plan: 'Execute the verified plan.', allowedActions: ['approve', 'approve_and_resume', 'reject'] },
      response: { kind: 'plan_approval', action },
    }} />);
    expect(container.querySelector('.agent-receipt-toggle')?.textContent).toContain(words);
    expect(container.querySelector('.agent-receipt-toggle')?.textContent).not.toContain(action === 'approve' ? 'carrying on' : action === 'reject' ? 'Plan approved' : 'Asked for');
  });

  it('keeps the complete reviewed plan, decision, and revision feedback in read-only history', async () => {
    const container = await render(<TimelineItemRenderer item={{
      type: 'interaction',
      request: { kind: 'plan_approval', requestId: 'plan', plan: '# Safe rollout\n1. **Inspect**\n2. Roll back on errors', allowedActions: ['approve_and_resume', 'reject'] },
      response: { kind: 'plan_approval', action: 'reject', feedback: 'Add a dry run' },
    }} />);
    expect(container.querySelector('.agent-receipt-toggle')?.textContent).toContain('Asked for changes to the plan');
    expect(container.querySelector('h1')).toBeNull();
    await openReceipts(container);
    expect(container.querySelector('h1')?.textContent).toBe('Safe rollout');
    expect(container.querySelector('strong')?.textContent).toBe('Inspect');
    expect(container.textContent).toContain('Roll back on errors');
    expect(container.textContent).toContain('Add a dry run');
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('preserves unknown option values and multiline custom-only answers', async () => {
    const container = await render(<TimelineItemRenderer item={{
      type: 'interaction',
      request: { kind: 'question', requestId: 'custom', questions: [
        { questionId: 'unknown', header: 'Option', prompt: 'Pick an option', required: false, selection: 'multiple', options: [], allowCustomText: true, allowDismiss: false },
        { questionId: 'custom', header: 'Notes', prompt: 'Add notes', required: false, selection: 'single', options: [], allowCustomText: true, allowDismiss: false },
      ] },
      response: { kind: 'question', answers: [{ questionId: 'unknown', selectedValues: ['unmapped-value'] }, { questionId: 'custom', selectedValues: [], customText: 'Keep the first line.\nKeep the second line, too.' }] },
    }} />);
    await openReceipts(container);
    const answers = container.querySelectorAll('.agent-completed-answer');
    expect(answers[0]?.querySelector('dd')?.textContent).toContain('unmapped-value');
    expect(answers[1]?.querySelector('.agent-answer-custom')?.textContent).toBe('Keep the first line.\nKeep the second line, too.');
    expect(container.querySelector('.agent-question-receipt-status')?.textContent).toBe('Answered');
    expect(container.querySelector('.agent-question-receipt-count')?.textContent).toBe('2 questions');
  });

  it('distinguishes a missing answer from dismissal and counts only answered questions', async () => {
    const request: Extract<AgentInteractionRequest, { kind: 'question' }> = { kind: 'question', requestId: 'partial', questions: [
      { questionId: 'answered', header: 'Answered one', prompt: 'Answer this?', required: false, selection: 'single', options: [], allowCustomText: true, allowDismiss: true },
      { questionId: 'missing', header: 'Missing one', prompt: 'Or this?', required: false, selection: 'single', options: [], allowCustomText: true, allowDismiss: true },
    ] };
    const partial = await render(<TimelineItemRenderer item={{
      type: 'interaction', request,
      response: { kind: 'question', answers: [{ questionId: 'answered', selectedValues: [], customText: 'Recorded answer' }] },
    }} />);
    expect(partial.querySelector('.agent-receipt-toggle')?.textContent).toContain('1 of 2 answered');
    await openReceipts(partial);
    expect(partial.querySelector('.agent-question-receipt-status')?.textContent).toBe('Partially answered');
    expect(partial.querySelector('.agent-question-receipt-count')?.textContent).toBe('1 of 2 answered');
    expect(partial.querySelectorAll('.agent-completed-answer')[1]?.textContent).toContain('No answer provided');

    const dismissed = await render(<TimelineItemRenderer item={{
      type: 'interaction', request: { ...request, requestId: 'dismissed' },
      response: { kind: 'question', dismissed: true, answers: [{ questionId: 'answered', selectedValues: [], customText: 'Recorded answer' }] },
    }} />);
    await openReceipts(dismissed);
    expect(dismissed.querySelector('.agent-question-receipt-status')?.textContent).toBe('Dismissed');
    expect(dismissed.querySelectorAll('.agent-completed-answer')[0]?.textContent).toContain('Recorded answer');
    expect(dismissed.querySelectorAll('.agent-completed-answer')[1]?.querySelector('.agent-answer-empty')?.textContent).toBe('Dismissed');
    expect(dismissed.textContent).not.toContain('No answer provided');
  });
});
