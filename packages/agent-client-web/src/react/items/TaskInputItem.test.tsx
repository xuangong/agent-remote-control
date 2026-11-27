// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { BOT_INSTRUCTIONS_VERSION, appendSessionReferences, assistantMessageText, chiefChangedText, itemChangedText, itemTagText, joinTaskInputs, personWroteText, standingInstructionsText, roomTurnText, taskBriefText, timerText, taskResultText, taskUpdateText } from '@orchardworks/agent-remote-protocol';
import { TaskDirectoryContext } from '../TaskDirectory.js';
import { render } from '../../test/setup.js';
import { UserMessageItem } from './MessageItem.js';

const message = (text: string) => ({ type: 'user_message' as const, text });

it('shows a sub-session result the Relay wrote as a card with its state and summary, not as the person\'s bubble', async () => {
  const container = await render(<UserMessageItem item={message(taskResultText({ taskId: 't1', outcome: 'finished', title: 'Collect logs', summary: 'The logs are in **/tmp/logs**.' }))} />);
  const card = container.querySelector('.agent-task-input')!;
  expect(card.getAttribute('data-task-kind')).toBe('done');
  expect(card.getAttribute('aria-label')).toBe('Sub-session Collect logs');
  expect(card.textContent).toContain('Sub-session reported');
  expect(card.querySelector('strong')?.textContent).toBe('/tmp/logs');
  // The guidance written for the model stays out of the person's view.
  expect(card.textContent).not.toContain('Check what matters');
  expect(container.querySelector('.agent-message-user')).toBeNull();
});

it('shows a sub-session its first work with who asked, also when a reference note follows it', async () => {
  const text = appendSessionReferences(taskBriefText({ taskId: 't1', from: 'Chief', title: 'Collect logs', brief: 'Collect the build logs.' }),
    { revision: 1, references: [{ address: 'host/codex/main', title: 'Chief', origin: 'source' }] });
  const container = await render(<UserMessageItem item={message(text)} />);
  const card = container.querySelector('.agent-task-input')!;
  expect(card.getAttribute('data-task-kind')).toBe('brief');
  expect(card.textContent).toContain('Work from Chief');
  expect(card.textContent).toContain('Collect the build logs.');
});

it('folds a bot\'s standing instructions into one quiet line, never the person\'s bubble', async () => {
  const container = await render(<UserMessageItem item={message(standingInstructionsText('Watch the build.'))} />);
  const folded = container.querySelector(`details[data-standing-version="${BOT_INSTRUCTIONS_VERSION}"]`)!;
  expect(folded.querySelector('summary')?.textContent).toBe('Standing instructions updated');
  expect(folded.textContent).toContain('Watch the build.');
  expect(container.querySelector('.agent-message-user')).toBeNull();
});

it('folds a due timer into one quiet line that opens to the bot\'s open work', async () => {
  const container = await render(<UserMessageItem item={message(timerText({ name: 'work', items: [{ title: 'Release notes', status: 'waiting', report: 'Publish' }] }))} />);
  const folded = container.querySelector('details[data-timer="work"]')!;
  expect(folded.querySelector('summary')?.textContent).toBe('Timer "work" is due');
  expect(folded.textContent).toContain('Release notes · waiting · Publish');
  expect(container.querySelector('.agent-message-user')).toBeNull();
});

it('folds what the person wrote to a bot into one quiet line that opens to their words', async () => {
  const container = await render(<UserMessageItem item={message(personWroteText({ bot: 'QA', text: 'Skip the flaky test.' }))} />);
  const folded = container.querySelector('details[data-person-wrote="QA"]')!;
  expect(folded.querySelector('summary')?.textContent).toBe('The person wrote to QA');
  expect(folded.textContent).toContain('Skip the flaky test.');
  expect(container.querySelector('.agent-message-user')).toBeNull();
});

it('keeps a sub-session\'s result a card, and shows what needs the person and what the person wrote to it as cards too', async () => {
  const text = joinTaskInputs([taskUpdateText({ taskId: 't1', kind: 'needs_you', label: 'Logs', body: 'Run npm test?' }), taskUpdateText({ taskId: 't1', kind: 'told', label: 'Logs', body: 'Skip the docs.' }),
    taskResultText({ taskId: 't1', outcome: 'interrupted', title: 'Logs', summary: 'The turn was interrupted.' })]);
  const container = await render(<UserMessageItem item={message(text)} />);
  expect([...container.querySelectorAll('.agent-task-input')].map(card => [card.getAttribute('data-task-kind'), card.querySelector('.agent-task-kicker')?.textContent])).toEqual([
    ['needs_you', 'A sub-session needs you'], ['told', 'You wrote to a sub-session'], ['interrupted', 'Sub-session was interrupted']]);
});

it('keeps text the person typed as their own bubble, even when it looks like a frame', async () => {
  const container = await render(<UserMessageItem item={message('[Sub-session t1 · result · Collect logs]\nAll good.')} />);
  expect(container.querySelector('.agent-task-input')).toBeNull();
  expect(container.querySelector('.agent-message-user')?.textContent).toContain('All good.');
});

it('shows updates that arrived together as one group of cards, each opening its sub-session where the page can', async () => {
  const opened: string[] = [];
  const text = joinTaskInputs([taskUpdateText({ taskId: 't2', kind: 'needs_you', label: 'Deploy', body: 'Run npm test?' }),
    taskResultText({ taskId: 't1', outcome: 'failed', title: 'Collect logs', summary: 'The runner is offline.' })]);
  const container = await render(<TaskDirectoryContext.Provider value={{ canOpen: id => id === 't1', open: id => { opened.push(id); }, owned: () => [] }}>
    <UserMessageItem item={message(text)} /></TaskDirectoryContext.Provider>);
  const cards = [...container.querySelectorAll('.agent-task-input')];
  expect(cards.map(card => [card.getAttribute('data-task-kind'), card.querySelector('.agent-task-kicker')?.textContent])).toEqual([['needs_you', 'A sub-session needs you'], ['failed', 'Sub-session could not finish']]);
  expect(cards[0]!.querySelector('.agent-task-open')).toBeNull();
  (cards[1]!.querySelector('.agent-task-open') as HTMLButtonElement).click();
  expect(opened).toEqual(['t1']);
});

it('offers no Open on a brief, which is already in the sub-session\'s conversation', async () => {
  const text = taskBriefText({ taskId: 't1', from: 'Chief', title: 'Collect logs', brief: 'Collect them.' });
  const container = await render(<TaskDirectoryContext.Provider value={{ canOpen: () => true, open: () => {}, owned: () => [] }}><UserMessageItem item={message(text)} /></TaskDirectoryContext.Provider>);
  expect(container.querySelector('.agent-task-input')).not.toBeNull();
  expect(container.querySelector('.agent-task-open')).toBeNull();
});

it('folds messages from another assistant into one line per sender beside task cards', async () => {
  const text = joinTaskInputs([taskResultText({ taskId: 't1', outcome: 'finished', title: 'Collect logs', summary: 'Attached.' }),
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

it('folds the notices of a changed item and a changed chief into one quiet line each, never the person\'s bubble', async () => {
  const text = joinTaskInputs([itemChangedText({ title: 'Track main', what: 'retitled to "Track trunk"; brief changed' }), chiefChangedText({ to: 'bot', bot: 'Tracker', from: 'Chief', chief: 'Reviewer' })]);
  const container = await render(<UserMessageItem item={message(text)} />);
  const lines = [...container.querySelectorAll('details[data-item-change]')];
  expect(lines.map(line => line.getAttribute('data-item-change'))).toEqual(['item_changed', 'chief_changed']);
  expect(lines.map(line => line.querySelector('summary')?.textContent)).toEqual(['Item "Track main" changed', 'Chief changed']);
  expect(lines[0]!.textContent).toContain('retitled to "Track trunk"; brief changed');
  expect(lines[1]!.textContent).toContain('your chief is now Reviewer');
  expect(container.querySelector('.agent-message-user')).toBeNull();
});

it('names the item an assignment serves in the folded line, and off the text, for a message and a brief', async () => {
  const tag = itemTagText({ key: 7, title: 'Run the regression', from: 'Chief' });
  const container = await render(<UserMessageItem item={message(assistantMessageText({ messageId: 'm123456789abc', from: 'Chief', tag, body: 'Watch the build.' }))} />);
  const folded = container.querySelector('details[data-message-ids]')!;
  expect(folded.querySelector('summary')?.textContent).toBe('Message from Chief · Item 7');
  expect(folded.querySelector('.agent-task-item')?.textContent).toBe('Item 7 · Run the regression');
  expect(folded.textContent).not.toContain('[Item');
  const brief = await render(<UserMessageItem item={message(taskBriefText({ taskId: 't1', from: 'Chief', title: 'Regression', brief: 'Run it.', tag }))} />);
  expect(brief.querySelector('.agent-task-input .agent-task-item')?.textContent).toBe('Item 7 · Run the regression');
  expect(brief.querySelector('.agent-task-input')?.textContent).not.toContain('[Item');
});
