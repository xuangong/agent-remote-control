import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryError, SessionDirectoryClient, type WorkspaceFolderPage } from './directory-client.js';
import { render, unmount } from '../test/setup.js';
import { WorkspaceFolderPicker } from './WorkspaceFolderPicker.js';

/** A Controller with a small folder tree: the picker only renders pages and sends the user's intent. */
function fakeController(tree: Record<string, { folders: string[]; hidden?: string[] }>) {
  const directory = new SessionDirectoryClient('http://localhost');
  const created: string[] = [];
  const folders = vi.spyOn(directory, 'folders').mockImplementation(async (_provider, options = {}) => {
    const path = options.path ?? '/root';
    const entry = tree[path];
    if (!entry) throw new DirectoryError('This folder cannot be opened.');
    const names = [...entry.folders, ...(options.hidden ? entry.hidden ?? [] : [])].filter(name => !options.search || name.includes(options.search));
    const parent = path === '/root' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
    return { path, parentPath: parent, roots: ['/root'], folders: names.map(name => ({ name, path: `${path}/${name}` })), nextOffset: null } satisfies WorkspaceFolderPage;
  });
  const createFolder = vi.spyOn(directory, 'createFolder').mockImplementation(async (_provider, parentPath, name) => {
    if (tree[parentPath]!.folders.includes(name)) throw new DirectoryError('A folder with this name already exists.');
    tree[parentPath]!.folders.push(name); tree[`${parentPath}/${name}`] = { folders: [] }; created.push(name);
    return { path: `${parentPath}/${name}` };
  });
  return { directory, folders, createFolder, created };
}

const dialog = () => document.querySelector('dialog')!;
const button = (label: string) => [...dialog().querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label) as HTMLButtonElement;
const field = (label: string) => [...dialog().querySelectorAll('label')].find(item => item.textContent?.startsWith(label))!.querySelector('input')!;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const click = (target: HTMLElement) => act(async () => target.click());
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(250); });

beforeEach(() => {
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); this.querySelector('button')!.focus(); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { vi.useRealTimers(); });

function mount(controller: ReturnType<typeof fakeController>, onSelect = vi.fn(), onClose = vi.fn(), initialPath = '/root') {
  return render(<WorkspaceFolderPicker directory={controller.directory} providerId="recorded" initialPath={initialPath} workspaces={[]} onSelect={onSelect} onClose={onClose} />)
    .then(async container => { await settle(); return { container, onSelect, onClose }; });
}
const rows = () => [...dialog().querySelectorAll('.lab-folder-row')].map(row => row.textContent);

describe('WorkspaceFolderPicker', () => {
  it('lists folders, reveals hidden ones on request, filters by name and selects the opened folder', async () => {
    const controller = fakeController({ '/root': { folders: ['My project'], hidden: ['.hidden'] }, '/root/My project': { folders: [] } });
    const { onSelect } = await mount(controller);
    expect(rows()).toEqual(['My project›']);
    await click(field('Hidden folders'));
    await settle();
    expect(rows()).toEqual(['My project›', '.hidden›']);
    await type(field('Filter folders'), 'My project');
    await settle();
    expect(rows()).toEqual(['My project›']);
    await click(dialog().querySelector<HTMLButtonElement>('.lab-folder-row')!);
    await settle();
    expect(dialog().textContent).toContain('No subfolders. You can select the current folder.');
    expect(field('Folder path').value).toBe('/root/My project');
    await click(button('Select folder'));
    expect(onSelect).toHaveBeenCalledWith('/root/My project');
  });

  it('returns focus to the control that opened it', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger); trigger.focus();
    const { container } = await mount(fakeController({ '/root': { folders: [] } }));
    await unmount(container);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('goes to the parent, refuses an invalid path without allowing selection, and closes without selecting', async () => {
    const controller = fakeController({ '/root': { folders: ['My project'] }, '/root/My project': { folders: [] } });
    const { onSelect, onClose } = await mount(controller);
    await click(dialog().querySelector<HTMLButtonElement>('.lab-folder-row')!);
    await settle();
    await click(button('Parent folder'));
    await settle();
    expect(rows()).toEqual(['My project›']);
    await type(field('Folder path'), '/root/missing');
    await click(button('Go'));
    await settle();
    expect(dialog().querySelector('[role=alert]')!.textContent).toContain('folder cannot be opened');
    expect(button('Select folder').disabled).toBe(true);
    await type(field('Folder path'), '/root');
    await click(button('Go'));
    await settle();
    expect(rows()).toEqual(['My project›']);
    await click(button('Cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('refuses an existing name, then creates a folder, enters it and selects it', async () => {
    const controller = fakeController({ '/root': { folders: ['My project'] } });
    const { onSelect } = await mount(controller);
    await click(button('＋ New folder'));
    const name = field('New folder name');
    await type(name, 'My project');
    await click(button('Create folder'));
    await settle();
    expect(dialog().querySelector('[role=alert]')!.textContent).toContain('already exists');
    expect(name.value).toBe('My project');
    await type(name, 'Fresh');
    await click(button('Create folder'));
    await settle();
    expect(field('Folder path').value).toBe('/root/Fresh');
    expect(dialog().querySelector('[role=status]')!.textContent).toContain('Folder created');
    await click(button('Select folder'));
    expect(onSelect).toHaveBeenCalledWith('/root/Fresh');
  });

  it('bounds an unconfirmed creation: it blocks Escape while pending, then offers a refresh', async () => {
    const controller = fakeController({ '/root': { folders: ['My project'] } });
    controller.createFolder.mockImplementation((_provider, _parent, _name, signal) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')))));
    const { onClose } = await mount(controller);
    await click(button('＋ New folder'));
    await type(field('New folder name'), 'Unconfirmed');
    await click(button('Create folder'));
    expect(button('Creating…').disabled).toBe(true);
    await act(async () => { dialog().dispatchEvent(new Event('cancel', { cancelable: true })); });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(dialog().querySelector('[role=alert]')!.textContent).toContain('folder may already exist');
    expect(field('New folder name').value).toBe('Unconfirmed');
    const before = controller.folders.mock.calls.length;
    await click(button('Refresh folders'));
    await settle();
    expect(controller.folders.mock.calls.length).toBeGreaterThan(before);
    await click(button('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});

it('returns focus to the control that opened it even when that control was never focused, as in Safari', async () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  const controller = fakeController({ '/root': { folders: [] } });
  const container = await render(<WorkspaceFolderPicker directory={controller.directory} providerId="recorded" initialPath="/root" workspaces={[]}
    onSelect={vi.fn()} onClose={vi.fn()} opener={{ current: opener }} />);
  await settle();
  expect(document.activeElement).not.toBe(opener);
  await unmount(container);
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
