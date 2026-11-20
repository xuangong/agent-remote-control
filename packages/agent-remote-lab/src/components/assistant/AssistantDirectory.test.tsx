import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { applyGroupOperation, createWindowView, type WindowGroup, type WindowGroupOperation } from '@orchardworks/agent-remote-protocol';
import { projectBotRoster } from '../../bot-roster.js';
import { botGroup } from '../../test/bot-mode-fixtures.js';
import { render } from '../../test/setup.js';
import { AssistantDirectory } from './AssistantDirectory.js';

/** A workspace of groups that applies the operations it is asked for, as the Relay would. */
function workspaceOf(groups: WindowGroup[]) {
  const state = [...groups], operations: Array<[string, WindowGroupOperation]> = [];
  return { operations, groups: state, readGroup: (id: string) => state.find(group => group.window.id === id),
    operateGroup: vi.fn(async (id: string, operation: WindowGroupOperation) => { operations.push([id, operation]); const index = state.findIndex(group => group.window.id === id); state[index] = applyGroupOperation(state[index]!, operation); return state[index]!; }) };
}
const view = (groups: WindowGroup[]) => projectBotRoster(groups, [], { status: () => 'idle', everyone: true });
const mount = (workspace: ReturnType<typeof workspaceOf>, props: Partial<Parameters<typeof AssistantDirectory>[0]> = {}) =>
  render(<AssistantDirectory model={view(workspace.groups)} workspace={workspace as unknown as Parameters<typeof AssistantDirectory>[0]['workspace']} onOpen={() => {}} {...props} />);
const press = async (root: ParentNode, label: string) => act(async () => ([...root.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label) as HTMLButtonElement).click());

it('lists every assistant by group in catalog order, marking the resting and the hidden', async () => {
  const first = botGroup('A'); first.bots!.members.A1 = { name: 'A1', hidden: true }; first.bots!.members.A2 = { name: 'A2', asleep: true };
  const second = botGroup('B');
  const container = await mount(workspaceOf([first, second]));
  expect([...container.querySelectorAll('.lab-directory-group h2')].map(item => item.firstChild?.textContent)).toEqual(['A', 'B']);
  const rows = [...container.querySelectorAll('.lab-bot-member')].map(item => item.querySelector('.lab-bot-name')?.textContent);
  expect(rows).toEqual(['A1', 'A2', 'B1', 'B2']);
  const marks = (name: string) => [...[...container.querySelectorAll('.lab-bot-member')].find(item => item.querySelector('.lab-bot-name')?.textContent === name)!.querySelectorAll('.lab-bot-role')].map(item => item.textContent);
  expect(marks('A1')).toEqual(['Hidden in Chats']); expect(marks('A2')).toEqual(['Resting']); expect(marks('B1')).toEqual([]);
});

it('opens an assistant in Chats, and shows a hidden one there again first', async () => {
  const first = botGroup('A'); first.bots!.members.A1 = { name: 'A1', hidden: true };
  const workspace = workspaceOf([first]); const onOpen = vi.fn();
  const container = await mount(workspace, { onOpen });
  await press(container, 'A2');
  expect(onOpen).toHaveBeenLastCalledWith({ kind: 'bot', groupId: 'A', viewId: 'A2' }); expect(workspace.operateGroup).not.toHaveBeenCalled();
  await press(container, 'A1');
  expect(workspace.operations).toEqual([['A', { type: 'bot.update', viewId: 'A1', details: { name: 'A1' } }]]);
  expect(onOpen).toHaveBeenLastCalledWith({ kind: 'bot', groupId: 'A', viewId: 'A1' });
});

it('shows a hidden assistant in Chats from its own button without leaving the directory', async () => {
  const first = botGroup('A'); first.bots!.members.A1 = { name: 'A1', hidden: true };
  const workspace = workspaceOf([first]); const onOpen = vi.fn();
  const container = await mount(workspace, { onOpen });
  await press(container, 'Show in Chats');
  expect(workspace.operations).toHaveLength(1); expect(onOpen).not.toHaveBeenCalled();
});

it('gives each group its actions: hide in either mode, and show a group hidden in Chats there again', async () => {
  const first = botGroup('A'); const hidden = { ...botGroup('B'), presentation: { bots: false as const } };
  const workspace = workspaceOf([first, hidden]);
  const container = await mount(workspace);
  const item = async (group: string, label: string) => { await press(container, `Group actions: ${group}`); await act(async () => ([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent === label))!.click()); };
  await item('A', 'Hide in Window mode');
  expect(workspace.operations.at(-1)).toEqual(['A', { type: 'window.remove' }]);
  await item('B', 'Show in Chats');
  expect(workspace.operations.at(-1)).toEqual(['B', { type: 'bots.show' }]);
  expect(container.querySelectorAll('.lab-directory-group')[1]!.textContent).toContain('Hidden in Chats');
});

it('offers New assistant and says so for an empty directory', async () => {
  const onNew = vi.fn();
  const container = await mount(workspaceOf([]), { onNew });
  expect(container.textContent).toContain('No assistants yet');
  await press(container, 'New assistant'); expect(onNew).toHaveBeenCalledOnce();
});

it('speaks Chinese when the device does', async () => {
  const group = botGroup('A'); group.bots!.members.A2 = { name: 'A2', asleep: true }; group.window.views.push(createWindowView('A3', { hostId: 'local', providerId: 'recorded', nativeSessionId: 'A3', title: 'A3' }));
  const workspace = workspaceOf([group]);
  const container = await render(<LocaleContext.Provider value="zh"><AssistantDirectory model={view(workspace.groups)} workspace={workspace as unknown as Parameters<typeof AssistantDirectory>[0]['workspace']} onOpen={() => {}} onNew={() => {}} /></LocaleContext.Provider>);
  expect(container.querySelector('h1')?.textContent).toBe('助手');
  expect(container.textContent).toContain('在休息');
});

it('marks a group that has an unread reply with a dot', async () => {
  const workspace = workspaceOf([botGroup('A'), botGroup('B')]);
  const model = projectBotRoster(workspace.groups, [], { status: () => 'idle', everyone: true, reply: () => ({ replyAt: 5, preview: 'ok' }), unread: session => session.nativeSessionId === 'B1' });
  const container = await render(<AssistantDirectory model={model} workspace={workspace as unknown as Parameters<typeof AssistantDirectory>[0]['workspace']} onOpen={() => {}} />);
  expect(container.querySelector('#directory-group-A .lab-bot-section-unread')).toBeNull();
  expect(container.querySelector('#directory-group-B .lab-bot-section-unread')?.getAttribute('aria-label')).toBe('Unread');
});
