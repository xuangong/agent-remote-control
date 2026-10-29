import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Team, TeamAction, TeamCreate } from '@orchardworks/agent-remote-protocol';
import { render } from '../../test/setup.js';

const fixture = vi.hoisted(() => ({ settings: { profiles: [] as any[], enablement: [] as any[] }, enabled: [] as any[] }));
vi.mock('@orchardworks/agent-remote-web/headless', async importOriginal => ({ ...await importOriginal<typeof import('@orchardworks/agent-remote-web/headless')>(),
  RemoteCallForSupportClient: class {
    async read() { return structuredClone(fixture.settings); }
    async enable(input: any) { fixture.enabled.push(input); fixture.settings.enablement = [{ ...input, updatedAt: 1 }]; return structuredClone(fixture.settings); }
  } }));
import { SupportSession } from './SupportSession.js';

const source = { hostId: 'mac', providerId: 'codex', nativeSessionId: 'worker', title: 'Implement login' };
const mandate = { supporters: [{ providerId: 'claude', model: 'opus' }], maxSupporters: 2, workspaces: ['shared' as const], remoteHosts: [], approval: 'every_roster' as const };
const profile = (id: string, name: string, enableByDefault = false) => ({ id, name, description: '', coordinator: {}, enableByDefault, revision: 1, updatedAt: 1, mandate });
const group: Team = { id: 'group', operationId: 'op', revision: 1, source, title: 'Cross review', status: 'active', createdAt: 1, updatedAt: 1, messages: [],
  members: [{ id: 'coordinator', hostId: 'mac', providerId: 'codex', role: 'leader', name: 'Coordinator', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1, nativeSessionId: 'c', access: 'read_only', workspace: { kind: 'shared' } },
    { id: 'requester', hostId: 'mac', providerId: 'codex', role: 'requester', name: 'Worker', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1, nativeSessionId: 'worker' }],
  callForSupport: { profileId: 'review', role: 'Cross review', description: '', coordinator: { providerId: 'codex' }, status: 'active', ledger: { text: '', revision: 0 }, usage: { tokens: 0 }, mandate,
    calls: [{ id: 'c1', task: 'Review the login change.', deliverable: 'findings', origin: 'worker', status: 'open', createdAt: 1, usage: { tokens: 0 } }] } };
const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
const control = (label: string) => [...document.querySelectorAll('label')].find(item => item.textContent?.startsWith(label))!.querySelector<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>('input, textarea, select')!;
async function set(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
}
function mount(teams: Team[] = []) {
  const requests: Array<TeamAction | TeamCreate> = [], updated: Team[] = [];
  const teamClient = { action: async (input: TeamAction) => { requests.push(input); return group; }, create: async (input: TeamCreate) => { requests.push(input); return group; } } as never;
  return { requests, updated, view: render(<SupportSession baseUrl="https://relay.test" source={source} teams={teams} teamClient={teamClient} busy={false}
    run={async action => { await action(); return true; }} onTeam={team => updated.push(team)} />) };
}
beforeEach(() => {
  fixture.settings = { profiles: [profile('review', 'Cross review'), profile('tests', 'Linux tests', true)], enablement: [] }; fixture.enabled = [];
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
});

it('follows profile defaults until the user chooses the profiles for the session', async () => {
  const { view } = mount(); const root = await view; await act(async () => {});
  const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes.map(box => box.checked)).toEqual([false, true]);
  expect(root.textContent).toContain('Following the profiles enabled by default.');
  await act(async () => boxes[0]!.click());
  await act(async () => button(root, 'Save for this session').click());
  expect(fixture.enabled).toEqual([{ ...source, profileIds: ['tests', 'review'] }].map(({ title: _title, ...entry }) => entry));
  expect(root.textContent).toContain('Chosen for this session.');
});

it('calls on a new role from a profile, and follows up on an existing role', async () => {
  const fresh = mount(); const root = await fresh.view; await act(async () => {});
  await act(async () => button(root, 'Call for support…').click());
  await set(control('Support'), 'profile:tests');
  await set(control('Task'), 'Run the Linux tests.');
  await set(control('Commit'), 'abcdef1');
  await act(async () => button(document, 'Call').click());
  expect(fresh.requests).toEqual([{ operationId: expect.any(String), source, callForSupport: { profileId: 'tests', call: { task: 'Run the Linux tests.', deliverable: 'findings', context: { commit: 'abcdef1' } } } }]);
  expect(fresh.updated).toEqual([group]);
});

it('lists the session\'s roles and calls on one of them', async () => {
  const existing = mount([group]); const root = await existing.view; await act(async () => {});
  expect(root.textContent).toContain('Cross review');
  expect(root.textContent).toContain('1 open call');
  await act(async () => button(root, 'Call for support…').click());
  await set(control('Follow up on'), 'c1');
  await set(control('Task'), 'Also check error paths.');
  await set(control('Deliverable'), 'answer');
  await act(async () => button(document, 'Call').click());
  expect(existing.requests).toEqual([{ action: 'call_for_support', teamId: 'group', operationId: expect.any(String), task: 'Also check error paths.', deliverable: 'answer', followUpOf: 'c1' }]);
});
