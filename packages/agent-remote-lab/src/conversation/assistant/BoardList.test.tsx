import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Board, BoardItem, BoardWriteResult } from '@orchardworks/agent-remote-protocol';
import { render } from '../../test/setup.js';
import { BoardList } from './BoardList.js';
import { boardTree, itemEdit, type BoardChoice } from './board-model.js';

const id = (n: number) => 'b_' + String(n).repeat(32);
const item = (key: number, extra: Partial<BoardItem> = {}): BoardItem => ({ key, title: `Item ${key}`, status: 'open', assignee: 'self', links: [], version: 1, changedAt: {}, updatedBy: id(1), updatedAt: 1_000, ...extra });
const board = (items: BoardItem[], plan?: Board['plan']): Board => ({ next: 20, items, ...(plan ? { plan } : {}) });
const names: Record<string, string> = { [id(2)]: 'Tracker', [id(5)]: 'Regression' };

function choice(own: Board, extra: Partial<BoardChoice> = {}): BoardChoice {
  return { board: own, name: botId => names[botId] ?? botId, choices: [{ botId: id(2), name: 'Tracker' }, { botId: id(5), name: 'Regression' }], ...extra };
}
const click = (element: Element | null | undefined) => act(async () => (element as HTMLElement).click());
const type = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});
const row = (container: Element, key: number) => container.querySelector<HTMLElement>(`[data-board-item="${key}"]`)!;
const expand = (container: Element, key: number) => click(row(container, key).querySelector('.lab-assistant-session-toggle'));
const button = (scope: Element, label: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === label);

describe('the model of a board', () => {
  it('puts open items in a tree by parent and the finished apart, newest first, with an orphan at the top', () => {
    const items = [item(1), item(2, { parent: 1 }), item(3, { parent: 2 }), item(4, { parent: 9 }), item(5, { status: 'done', closedAt: 10 }), item(6, { status: 'cancelled', closedAt: 20 }), item(7, { parent: 5 })];
    const tree = boardTree(items);
    expect(tree.roots.map(node => node.item.key)).toEqual([1, 4, 7]);
    expect(tree.roots[0]!.children[0]!.children.map(node => node.item.key)).toEqual([3]);
    expect(tree.finished.map(entry => entry.key)).toEqual([6, 5]);
  });

  it('writes only what the person changed, naming the version they read, and never an empty brief', () => {
    const entry = item(3, { version: 4, brief: 'Watch main.', status: 'working' });
    expect(itemEdit(entry, { title: ' Item 3 ', status: 'working', assignee: 'self', brief: 'Watch main.' })).toBeUndefined();
    expect(itemEdit(entry, { title: 'Track main', status: 'waiting', assignee: id(2), brief: '' })).toEqual({ key: 3, version: 4, title: 'Track main', status: 'waiting', assignee: id(2) });
  });
});

describe('the board in a bot\'s details', () => {
  const rich = board([
    item(1, { title: 'Release 2.0', status: 'working', assignee: id(2), report: 'Build is red.', brief: 'Cut the release.', links: [{ kind: 'branch', value: 'release/2.0' }, { kind: 'bot', value: id(5) }] }),
    item(2, { title: 'Write notes', parent: 1, status: 'waiting', result: 'Draft ready.' }),
    item(3, { title: 'Old job', status: 'done', closedAt: 5, result: 'Shipped.' }),
    item(4, { title: 'Dropped idea', status: 'cancelled', closedAt: 6 })],
  { text: 'Ship the release first.', version: 3, changes: [{ at: 900, by: 'person', why: 'You asked for speed.' }, { at: 800, by: id(1), why: 'The build broke.' }] });

  it('shows the plan note with its changes, then open items as a tree with status, assignee, links, result and latest report, and finished ones under Done', async () => {
    const container = await render(<BoardList choice={choice(rich)} />);
    const plan = container.querySelector('[data-board-plan]')!;
    expect(plan.textContent).toContain('Ship the release first.');
    expect(plan.querySelector('details summary')!.textContent).toBe('Changes (2)');
    expect(plan.querySelector('details')!.textContent).toContain('you: You asked for speed.');
    // Section order: the plan note, then the items.
    expect(container.querySelector('[data-board-plan]')!.compareDocumentPosition(container.querySelector('.lab-board-items')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const first = row(container, 1);
    expect(first.querySelector('.lab-board-title')!.textContent).toBe('Release 2.0');
    expect(first.querySelector('.lab-board-status')!.textContent).toBe('Working');
    expect(first.textContent).toContain('Assigned to Tracker');
    expect(first.textContent).toContain('branch: release/2.0');
    expect(first.textContent).toContain('bot: Regression');
    expect(first.textContent).toContain('Latest report: Build is red.');
    // The child sits inside its parent; the brief shows on expansion only.
    expect(first.querySelector('.lab-board-children [data-board-item="2"]')).not.toBeNull();
    expect(row(container, 2).textContent).toContain('Result: Draft ready.');
    expect(first.textContent).not.toContain('Cut the release.');
    await expand(container, 1);
    expect(first.textContent).toContain('Brief: Cut the release.');
    // Finished items are folded under Done.
    const done = container.querySelector('details.lab-board-done')!;
    expect(done.querySelector('summary')!.textContent).toBe('Done (2)');
    expect([...done.querySelectorAll('[data-board-item]')].map(entry => entry.getAttribute('data-board-item'))).toEqual(['4', '3']);
    expect(done.closest('li')).toBeNull();
  });

  it('opens the session or bot doing an item from the item, and only when it can be opened', async () => {
    const open = vi.fn();
    const container = await render(<BoardList choice={choice(rich, { canOpen: botId => botId === id(2), open })} />);
    await expand(container, 1);
    await click(button(row(container, 1), 'Open Tracker'));
    expect(open).toHaveBeenCalledWith(id(2));
    await expand(container, 2);
    expect(button(row(container, 2), 'Open the assistant itself')).toBeUndefined();
  });

  it('expands an item assigned to a staff bot into that bot\'s board, read only and one level deep', async () => {
    const staff = board([item(1, { title: 'Poll the build', status: 'working', assignee: id(5) }), item(2, { title: 'Report red', status: 'open' })], { text: 'Poll every minute.', version: 1, changes: [] });
    const save = vi.fn(async (): Promise<BoardWriteResult> => ({ items: [] }));
    const container = await render(<BoardList choice={choice(rich, { staffBoard: botId => botId === id(2) ? staff : botId === id(5) ? board([item(1, { title: 'Deeper' })]) : undefined, save })} />);
    await expand(container, 1);
    const section = container.querySelector<HTMLElement>(`[data-staff-board="${id(2)}"]`)!;
    expect(section.getAttribute('aria-label')).toBe('Board of Tracker (read only)');
    expect(section.textContent).toContain('Poll every minute.');
    expect([...section.querySelectorAll('.lab-board-title')].map(title => title.textContent)).toEqual(['Poll the build', 'Report red']);
    // Read only: no edit, no cancel, no plan editor in it; and its own staff do not open a second level.
    expect(button(section, 'Edit item') ?? button(section, 'Cancel item') ?? button(section, 'Edit plan')).toBeUndefined();
    await click(section.querySelector('[data-board-item="1"] .lab-assistant-session-toggle'));
    expect(section.querySelector('[data-staff-board]')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('edits an item in place, writes only what changed with the version read as the person, and closes the form', async () => {
    const save = vi.fn(async (_edit: unknown): Promise<BoardWriteResult> => ({ items: [{ key: 1, version: 2 }] }));
    const container = await render(<BoardList choice={choice(rich, { save })} />);
    await expand(container, 1);
    await click(button(row(container, 1), 'Edit item'));
    const form = row(container, 1).querySelector('form')!;
    const [title, status, assignee, brief] = [...form.querySelectorAll<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>('input, select, textarea')];
    expect(button(form, 'Save item')!.disabled).toBe(true);
    await type(title!, 'Release 2.0.1');
    await type(status!, 'waiting');
    await type(assignee!, id(5));
    await type(brief!, 'Cut the patch release.');
    expect([...assignee!.querySelectorAll('option')].map(option => option.textContent)).toEqual(['the assistant itself', 'Tracker', 'Regression']);
    await click(button(form, 'Save item'));
    expect(save).toHaveBeenCalledWith({ items: [{ key: 1, version: 1, title: 'Release 2.0.1', status: 'waiting', assignee: id(5), brief: 'Cut the patch release.' }] });
    expect(row(container, 1).querySelector('form')).toBeNull();
  });

  it('cancels an item with one press, and edits the plan note with a why and the version it read', async () => {
    const save = vi.fn(async (_edit: unknown): Promise<BoardWriteResult> => ({ items: [] }));
    const container = await render(<BoardList choice={choice(rich, { save })} />);
    await expand(container, 2);
    await click(button(row(container, 2), 'Cancel item'));
    expect(save).toHaveBeenLastCalledWith({ items: [{ key: 2, version: 1, status: 'cancelled' }] });
    // Finished items offer no cancel.
    await expand(container, 3);
    expect(button(row(container, 3), 'Cancel item')).toBeUndefined();
    await click(button(container.querySelector('[data-board-plan]')!, 'Edit plan'));
    const plan = container.querySelector('[data-board-plan] form')!;
    const [text, why] = [...plan.querySelectorAll<HTMLInputElement & HTMLTextAreaElement>('textarea, input')];
    expect(button(plan, 'Save plan')!.disabled).toBe(true);
    await type(text!, 'Ship notes first.');
    expect(button(plan, 'Save plan')!.disabled).toBe(true);
    await type(why!, 'The notes block the release.');
    await click(button(plan, 'Save plan'));
    expect(save).toHaveBeenLastCalledWith({ plan: { text: 'Ship notes first.', why: 'The notes block the release.', version: 3 } });
  });

  it('creates an item from the details with a title and optionally an assignee, a brief and a parent, and only with a title', async () => {
    const save = vi.fn(async (_edit: unknown): Promise<BoardWriteResult> => ({ items: [{ key: 5, version: 1 }] }));
    const container = await render(<BoardList choice={choice(rich, { save })} />);
    await click(button(container, 'New item'));
    const form = container.querySelector('[data-board-new]')!;
    const [title, assignee, brief, parent] = [...form.querySelectorAll<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>('input, select, textarea')];
    expect(button(form, 'Add item')!.disabled).toBe(true);
    expect([...parent!.querySelectorAll('option')].map(option => option.textContent)).toEqual(['No parent', 'Release 2.0', 'Write notes']);
    await type(title!, ' Check the logs ');
    await click(button(form, 'Add item'));
    expect(save).toHaveBeenLastCalledWith({ items: [{ title: 'Check the logs' }] });
    expect(container.querySelector('[data-board-new]')).toBeNull();
    await click(button(container, 'New item'));
    const again = [...container.querySelectorAll<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>('[data-board-new] input, [data-board-new] select, [data-board-new] textarea')];
    await type(again[0]!, 'Trace the failure');
    await type(again[1]!, id(2));
    await type(again[2]!, 'Find the first red run.');
    await type(again[3]!, '1');
    await click(button(container.querySelector('[data-board-new]')!, 'Add item'));
    expect(save).toHaveBeenLastCalledWith({ items: [{ title: 'Trace the failure', assignee: id(2), brief: 'Find the first red run.', parent: 1 }] });
  });

  it('offers no new item on a board that cannot be written', async () => {
    const container = await render(<BoardList choice={choice(rich)} />);
    expect(button(container, 'New item')).toBeUndefined();
  });

  it('shows what a stale edit overwrote, who set it and what it was, and keeps the Relay\'s refusal as an alert', async () => {
    const save = vi.fn(async (_edit: unknown): Promise<BoardWriteResult> => ({ items: [{ key: 1, version: 3, overwrote: [{ field: 'status', was: 'waiting', by: id(2) }, { field: 'assignee', was: 'self', by: 'person' }] }],
      plan: { version: 4, overwrote: [{ field: 'plan', was: 'Old plan.', by: id(1) }] } }));
    const container = await render(<BoardList choice={choice(rich, { save })} />);
    await expand(container, 1);
    await click(button(row(container, 1), 'Cancel item'));
    expect([...container.querySelectorAll('[role="status"]')].map(line => line.textContent)).toEqual([
      'Your edit replaced the status: it was “Waiting” (set by Tracker).', 'Your edit replaced the assignee: it was “the assistant itself” (set by you).', 'Your edit replaced the plan note: it was “Old plan.” (set by ' + id(1) + ').']);
    save.mockRejectedValueOnce(new Error('No item 1 on the board.'));
    await click(button(row(container, 1), 'Cancel item'));
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('No item 1 on the board.');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('shows a board without a way to write as read only, and an empty one as such', async () => {
    const container = await render(<BoardList choice={choice(board([]))} />);
    expect(container.textContent).toContain('No plan note yet.');
    expect(container.textContent).toContain('No open items.');
    expect(button(container, 'Add a plan note')).toBeUndefined();
    expect(container.querySelector('details.lab-board-done')).toBeNull();
  });
});
