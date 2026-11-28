import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../../test/setup.js';
import { WorkbenchHeader } from './WorkbenchHeader.js';

const props = () => ({ name: 'Dango', needsYou: 2, working: 3, chief: { botId: 'c', name: 'Boss' }, staff: [{ botId: 's1', name: 'Pebbles' }], ledgerOpen: false,
  onOpenWorkbench: vi.fn(), onOpenChat: vi.fn(), onFocusNeedsYou: vi.fn(), onToggleLedger: vi.fn() });
const button = (root: ParentNode, name: string) => [...root.querySelectorAll('button')].find(item => item.textContent === name)!;

it('names the bot, what needs the person, and its chief and staff', async () => {
  const container = await render(<WorkbenchHeader {...props()} />);
  expect(container.querySelector('h2')!.textContent).toBe('Dango');
  expect(container.textContent).toContain('2 need you');
  expect(container.textContent).toContain('3 working');
  expect(button(container, 'Chief: Boss')).toBeDefined();
  expect(button(container, 'Pebbles')).toBeDefined();
});
it('switches to a staff bot\'s workbench, goes to what needs the person, opens the chat and toggles the ledger', async () => {
  const p = props();
  const container = await render(<WorkbenchHeader {...p} />);
  await act(async () => button(container, 'Pebbles').click());
  expect(p.onOpenWorkbench).toHaveBeenCalledWith('s1');
  await act(async () => button(container, 'Chief: Boss').click());
  expect(p.onOpenWorkbench).toHaveBeenCalledWith('c');
  await act(async () => button(container, '2 need you').click());
  expect(p.onFocusNeedsYou).toHaveBeenCalledTimes(1);
  await act(async () => button(container, 'Open in chat').click());
  expect(p.onOpenChat).toHaveBeenCalledTimes(1);
  await act(async () => button(container, 'Ledger').click());
  expect(p.onToggleLedger).toHaveBeenCalledTimes(1);
});
it('shows no count and no chips when there is nothing to show, rather than a zero or an empty list', async () => {
  const container = await render(<WorkbenchHeader {...props()} needsYou={0} working={0} chief={undefined} staff={[]} />);
  expect(container.textContent).not.toContain('need you');
  expect(container.querySelector('.lab-workbench-chips')).toBeNull();
});
