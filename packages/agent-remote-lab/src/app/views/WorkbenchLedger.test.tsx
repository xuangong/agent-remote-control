import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { Board } from '@orchardworks/agent-remote-protocol';
import { TaskDirectoryContext, type TaskDirectory } from '@orchardworks/agent-client-web/react';
import { render } from '../../test/setup.js';
import { WorkbenchLedger } from './WorkbenchLedger.js';

const item = (key: number, title: string, assignee: string) => ({ key, title, status: 'working' as const, assignee, links: [], version: 1, changedAt: {}, updatedBy: 'person', updatedAt: 1, createdAt: 1 });
const board: Board = { next: 3, items: [item(1, 'Fix the build', 's_1'), item(2, 'Write notes', 'self')] } as unknown as Board;
const directory = (): TaskDirectory => ({ canOpen: () => false, open: () => {}, owned: () => [], act: async () => {}, boardOf: () => board, botName: id => id === 's_1' ? 'Research' : id, assignees: () => [] });

it('shows the bot\'s items and links an owner to its tile', async () => {
  const open = vi.fn();
  const container = await render(<TaskDirectoryContext.Provider value={directory()}><WorkbenchLedger botId="b1" canOpenOwner={id => id === 's_1'} onOpenOwner={open} /></TaskDirectoryContext.Provider>);
  expect(container.querySelector('aside')!.getAttribute('aria-label')).toBe('Ledger');
  expect(container.textContent).toContain('Fix the build');
  const toggle = container.querySelector<HTMLButtonElement>('.lab-assistant-session-toggle')!;
  await act(async () => toggle.click());
  const owner = [...container.querySelectorAll('button')].find(button => /Open Research/.test(button.getAttribute('aria-label') ?? button.textContent ?? ''));
  expect(owner).toBeDefined();
  await act(async () => owner!.click());
  expect(open).toHaveBeenCalledWith('s_1');
});
it('draws no empty words before the ledger is known', async () => {
  const container = await render(<TaskDirectoryContext.Provider value={{ ...directory(), boardOf: () => undefined }}><WorkbenchLedger botId="b1" canOpenOwner={() => false} onOpenOwner={() => {}} /></TaskDirectoryContext.Provider>);
  expect(container.querySelector('[data-ledger-loading]')).not.toBeNull();
  expect(container.textContent).toBe('');
});
