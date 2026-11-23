// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { appendSessionReferences, assistantMessageText, joinTaskInputs, standingInstructionsText, roomTurnText, taskBriefText, timerText, taskResultText, taskUpdateText } from '@orchardworks/agent-remote-protocol';
import { TaskDirectoryContext } from '../TaskDirectory.js';
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

it('folds a bot\'s standing instructions into one quiet line, never the person\'s bubble', async () => {
  const container = await render(<UserMessageItem item={message(standingInstructionsText('Watch the build.'))} />);
  const folded = container.querySelector('details[data-standing-version="2"]')!;
  expect(folded.querySelector('summary')?.textContent).toBe('Standing instructions updated');
  expect(folded.textContent).toContain('Watch the build.');
  expect(container.querySelector('.agent-message-user')).toBeNull();
});

it('folds a due timer into one quiet line that opens to the bot\'s open work', async () => {
  const container = await render(<UserMessageItem item={message(timerText({ name: 'work', work: [{ title: 'Release notes', phase: 'waiting', next: 'Publish' }] }))} />);
  const folded = container.querySelector('details[data-timer="work"]')!;
  expect(folded.querySelector('summary')?.textContent).toBe('Timer "work" is due');
  expect(folded.textContent).toContain('Release notes · waiting · next: Publish');
  expect(container.querySelector('.agent-message-user')).toBeNull();
});

it('keeps text the person typed as their own bubble, even when it looks like a frame', async () => {
  const container = await render(<UserMessageItem item={message('[Task t1 · done · Collect logs]\nAll good.')} />);
  expect(container.querySelector('.agent-task-input')).toBeNull();
  expect(container.querySelector('.agent-message-user')?.textContent).toContain('All good.');
});

it('shows updates that arrived together as one group of cards, each opening its task where the page can', async () => {
  const opened: string[] = [];
  const text = joinTaskInputs([taskUpdateText({ taskId: 't2', kind: 'question', label: 'Deploy', body: 'Which region?' }),
    taskResultText({ taskId: 't1', status: 'failed', title: 'Collect logs', summary: 'The runner is offline.' })]);
  const container = await render(<TaskDirectoryContext.Provider value={{ canOpen: id => id === 't1', open: id => { opened.push(id); }, owned: () => [] }}>
    <UserMessageItem item={message(text)} /></TaskDirectoryContext.Provider>);
  const cards = [...container.querySelectorAll('.agent-task-input')];
  expect(cards.map(card => [card.getAttribute('data-task-kind'), card.querySelector('.agent-task-kicker')?.textContent])).toEqual([['question', 'Question from a task'], ['failed', 'Task not finished']]);
  expect(cards[0]!.querySelector('.agent-task-open')).toBeNull();
  (cards[1]!.querySelector('.agent-task-open') as HTMLButtonElement).click();
  expect(opened).toEqual(['t1']);
});

it('offers no Open on a brief, which is already in the worker\'s conversation', async () => {
  const text = taskBriefText({ taskId: 't1', from: 'Chief', title: 'Collect logs', brief: 'Collect them.' });
  const container = await render(<TaskDirectoryContext.Provider value={{ canOpen: () => true, open: () => {}, owned: () => [] }}><UserMessageItem item={message(text)} /></TaskDirectoryContext.Provider>);
  expect(container.querySelector('.agent-task-input')).not.toBeNull();
  expect(container.querySelector('.agent-task-open')).toBeNull();
});

it('folds messages from another assistant into one line per sender beside task cards', async () => {
  const text = joinTaskInputs([taskResultText({ taskId: 't1', status: 'done', title: 'Collect logs', summary: 'Attached.' }),
    assistantMessageText({ messageId: 'm000000000001', from: 'Tracker', body: 'Branch is cut.' }), assistantMessageText({ messageId: 'm000000000002', from: 'Tracker', replyTo: 'm00000000000a', body: 'Tag pushed.' })]);
  const container = await render(<UserMessageItem item={message(text)} />);
  expect(container.querySelectorAll('.agent-task-input')).toHaveLength(1);
  const folded = container.querySelector('details.agent-assistant-messages')!;
  expect(folded.querySelector('summary')?.textContent).toBe('2 messages from Tracker');
  expect(folded.hasAttribute('open')).toBe(false);
  expect(folded.textContent).toContain('Tag pushed.');
});

it('folds a room\'s turn into one line naming the room', async () => {
  const container = await render(<UserMessageItem item={message(roomTurnText({ roomId: 'r1', name: 'Release', messages: [{ name: 'Chief', text: 'Ready?' }], minutesLeft: 5 }))} />);
  expect(container.querySelector('details[data-room-id="r1"] summary')?.textContent).toBe('Your turn in Release · 1 new message');
});
