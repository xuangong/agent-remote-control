// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { TaskDirectoryContext, type TaskDirectory, type SideCard } from '../TaskDirectory.js';
import { render } from '../../test/setup.js';
import { SideCards } from './SideCards.js';

const card: SideCard = { taskId: 't1', title: 'printf or echo', status: 'done', summary: 'Use printf: it is portable.', at: 5 };
const directory = (extra: Partial<TaskDirectory> = {}): TaskDirectory => ({ canOpen: () => true, open: () => {}, owned: () => [], act: async () => {}, ...extra });

it('shows a side\'s answer as a card beside the conversation, with Open and Bring back', async () => {
  const open = vi.fn(), bringBack = vi.fn(async () => {});
  const container = await render(<TaskDirectoryContext.Provider value={directory({ open, bringBack })}><SideCards cards={[card]} agentId="agent-1" /></TaskDirectoryContext.Provider>);
  const article = container.querySelector('[data-side-card="t1"]')!;
  expect(article.textContent).toContain('Side "printf or echo" answered');
  expect(article.textContent).toContain('Use printf: it is portable.');
  await act(async () => container.querySelector<HTMLButtonElement>('button.agent-task-open:not([data-bring-back])')!.click());
  expect(open).toHaveBeenCalledWith('t1');
  await act(async () => container.querySelector<HTMLButtonElement>('[data-bring-back]')!.click());
  expect(bringBack).toHaveBeenCalledWith(card, 'agent-1');
  const sent = container.querySelector<HTMLButtonElement>('[data-bring-back]')!;
  expect([sent.textContent, sent.disabled]).toEqual(['Brought back', true]);
});

it('offers no Bring back where the page cannot send into the conversation', async () => {
  const container = await render(<TaskDirectoryContext.Provider value={directory()}><SideCards cards={[{ ...card, status: 'failed' }]} agentId="agent-1" /></TaskDirectoryContext.Provider>);
  expect(container.querySelector('[data-bring-back]')).toBeNull();
  expect(container.textContent).toContain('could not finish');
});
