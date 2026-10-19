import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TeamMenu } from './TeamMenu.js';
import { render } from '../test/setup.js';
import type { Team } from '@orchardworks/agent-remote-protocol';

const team: Team = { id: 'team', operationId: 'create', revision: 1, title: 'Investigation', status: 'active',
  source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'main', title: 'Project' },
  members: [{ id: 'leader', hostId: 'mac', providerId: 'codex', nativeSessionId: 'leader-session', name: 'Leader',
    role: 'leader', responsibility: '', summary: '', creation: 'ready', activity: 'idle', updatedAt: 1 }],
  messages: [], createdAt: 1, updatedAt: 1 };
const providers = [{ providerId: 'codex', displayName: 'Codex' }, { providerId: 'claude', displayName: 'Claude' }];
const hosts = ['mac', 'win'].map(id => ({ id, name: id, online: true, teamManagement: true as const, providers }));
const button = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLButtonElement>('button')]
  .find(item => (item.getAttribute('aria-label') ?? item.textContent) === name)!;
const field = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLLabelElement>('label')]
  .find(item => item.textContent?.startsWith(name))!.control as HTMLSelectElement;
async function select(root: ParentNode, name: string, value: string) {
  await act(async () => { const input = field(root, name); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); });
}
const requests: URL[] = [], actions: unknown[] = [];
let workspaces: (url: URL) => Promise<Response>;
beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.open = true; } },
    close: { configurable: true, value() { this.open = false; } },
  });
  workspaces = async url => Response.json({ workspaces: [{ id: 'project', name: 'Project', path: url.pathname.includes('/win/') ? 'C:\\Projects\\app' : '/work/app' }] });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); requests.push(url);
    if (url.pathname.endsWith('/teams')) return Response.json({ teams: [team] });
    if (url.pathname.endsWith('/teams/action')) { actions.push(JSON.parse(String(init?.body))); return Response.json(team); }
    if (url.pathname.endsWith('/workspaces')) return workspaces(url);
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; actions.length = 0; localStorage.clear(); });

async function openEditor() {
  const view = await render(<TeamMenu baseUrl="https://team.test/" enabled hosts={hosts} onOpen={async () => true} onOpenSession={async () => true} />);
  await act(async () => button(view, 'Teams').click());
  await act(async () => button(view, 'Add member').click());
  return document.querySelector<HTMLDialogElement>('[data-team-dialog]')!;
}

it('requires a selected workspace and submits its Host path unchanged', async () => {
  const editor = await openEditor();
  expect(button(editor, 'Add member').disabled).toBe(true);
  expect(editor.querySelector('input[placeholder="Host default directory"]')).toBeNull();
  await act(async () => editor.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(actions).toHaveLength(0);
  await select(editor, 'Host', 'win');
  await select(editor, 'Workspace', 'project');
  expect(button(editor, 'Add member').disabled).toBe(false);
  await act(async () => button(editor, 'Add member').click());
  expect(actions).toEqual([expect.objectContaining({ action: 'add_member', hostId: 'win', providerId: 'codex', cwd: 'C:\\Projects\\app' })]);
  expect(requests.some(url => url.pathname === '/v1/remote/hosts/win/workspaces' && url.searchParams.get('providerId') === 'codex')).toBe(true);
});

it('clears the selection on Host or Provider changes and discards retired workspace results', async () => {
  const editor = await openEditor();
  await select(editor, 'Workspace', 'project');
  let finish!: (response: Response) => void;
  workspaces = url => url.pathname.includes('/win/')
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve(Response.json({ workspaces: [{ id: 'other', name: 'Other', path: '/other/app' }] }));
  await select(editor, 'Host', 'win');
  expect(button(editor, 'Add member').disabled).toBe(true);
  expect(field(editor, 'Workspace').value).toBe('');
  await select(editor, 'Host', 'mac');
  await act(async () => finish(Response.json({ workspaces: [{ id: 'stale', name: 'Wrong Host', path: 'C:\\wrong' }] })));
  expect(field(editor, 'Workspace').textContent).not.toContain('Wrong Host');
  await select(editor, 'Workspace', 'other');
  expect(button(editor, 'Add member').disabled).toBe(false);
  await select(editor, 'Provider', 'claude');
  expect(button(editor, 'Add member').disabled).toBe(true);
  expect(field(editor, 'Workspace').value).toBe('');
  await select(editor, 'Workspace', 'other');
  await act(async () => button(editor, 'Add member').click());
  expect(actions).toEqual([expect.objectContaining({ hostId: 'mac', providerId: 'claude', cwd: '/other/app' })]);
});

it('explains when a selected path exceeds the Team contract limit', async () => {
  workspaces = async () => Response.json({ workspaces: [{ id: 'long', name: 'Long path', path: '/' + 'a'.repeat(2048) }] });
  const editor = await openEditor();
  await select(editor, 'Workspace', 'long');
  expect(button(editor, 'Add member').disabled).toBe(true);
  expect(editor.querySelector('[role="alert"]')?.textContent).toContain('2,048');
  expect(actions).toHaveLength(0);
});
