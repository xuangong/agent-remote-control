// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { appendSessionReferences, taskBriefText, taskResultText } from '@orchardworks/agent-remote-protocol';
import { render } from '../../test/setup.js';
import { UserMessageItem } from './MessageItem.js';

const message = (text: string) => ({ type: 'user_message' as const, text });

it('shows a task result the Relay wrote as a card with its state and summary, not as the person\'s bubble', async () => {
  const container = await render(<UserMessageItem item={message(taskResultText({ taskId: 't1', status: 'done', title: 'Collect logs', summary: 'The logs are in **/tmp/logs**.' }))} />);
  const card = container.querySelector('.agent-task-input')!;
  expect(card.getAttribute('data-task-kind')).toBe('done');
  expect(card.getAttribute('aria-label')).toBe('Task Collect logs');
  expect(card.textContent).toContain('Task done');
  expect(card.querySelector('strong')?.textContent).toBe('/tmp/logs');
  // The guidance written for the model stays out of the person's view.
  expect(card.textContent).not.toContain('worker\'s report');
  expect(container.querySelector('.agent-message-user')).toBeNull();
});

it('shows a worker its brief with who asked and the done-when line, also when a reference note follows it', async () => {
  const text = appendSessionReferences(taskBriefText({ taskId: 't1', from: 'Chief', title: 'Collect logs', brief: 'Collect the build logs.', doneWhen: 'The logs are attached.' }),
    { revision: 1, references: [{ address: 'host/codex/main', title: 'Chief', origin: 'source' }] });
  const container = await render(<UserMessageItem item={message(text)} />);
  const card = container.querySelector('.agent-task-input')!;
  expect(card.getAttribute('data-task-kind')).toBe('brief');
  expect(card.textContent).toContain('Task from Chief');
  expect(card.textContent).toContain('Collect the build logs.');
  expect(card.querySelector('.agent-task-done-when')?.textContent).toBe('Done when: The logs are attached.');
});

it('keeps text the person typed as their own bubble, even when it looks like a frame', async () => {
  const container = await render(<UserMessageItem item={message('[Task t1 · done · Collect logs]\nAll good.')} />);
  expect(container.querySelector('.agent-task-input')).toBeNull();
  expect(container.querySelector('.agent-message-user')?.textContent).toContain('All good.');
});
