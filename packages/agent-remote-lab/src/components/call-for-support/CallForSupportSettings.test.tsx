import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CallForSupportProfile } from '@orchardworks/agent-remote-protocol';
import { render, setPromptText } from '../../test/setup.js';

const fixture = vi.hoisted(() => ({ profiles: [] as any[], commands: [] as any[], conflict: false }));
vi.mock('@orchardworks/agent-remote-web/headless', async importOriginal => {
  const original = await importOriginal<typeof import('@orchardworks/agent-remote-web/headless')>();
  return { ...original, RemoteCallForSupportClient: class {
    async read() { return { profiles: structuredClone(fixture.profiles), enablement: [] }; }
    async profile(command: any) {
      fixture.commands.push(command);
      if (fixture.conflict) { fixture.conflict = false; throw new original.CallForSupportConflictError('changed'); }
      if (command.type === 'create') fixture.profiles.push({ ...command.profile, id: `p${fixture.profiles.length}`, revision: 1, updatedAt: 1 });
      if (command.type === 'update') fixture.profiles = fixture.profiles.map(profile => profile.id === command.id ? { ...command.profile, id: command.id, revision: command.revision + 1, updatedAt: 2 } : profile);
      if (command.type === 'delete') fixture.profiles = fixture.profiles.filter(profile => profile.id !== command.id);
      return { profiles: structuredClone(fixture.profiles), enablement: [] };
    }
  } };
});
import { CallForSupportSettings } from './CallForSupportSettings.js';

const hosts = [{ id: 'mac', name: 'Mac', providers: [{ providerId: 'codex', displayName: 'Codex' }, { providerId: 'claude', displayName: 'Claude Code' }] }];
const profile: CallForSupportProfile = { id: 'review', name: 'Cross review', description: 'Two reviewers.', coordinator: {}, enableByDefault: false, revision: 3, updatedAt: 1,
  mandate: { supporters: [{ providerId: 'claude', model: 'opus' }], maxSupporters: 2, workspaces: ['shared'], remoteHosts: [], approval: 'every_roster' } };
const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent)?.includes(text))!;
const field = (label: string, index = 0) => [...document.querySelectorAll('label')].filter(item => item.textContent?.startsWith(label))[index]!.querySelector<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>('input, textarea, select')!;
async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { setPromptText(input as HTMLTextAreaElement, value); if (input instanceof HTMLInputElement) Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
beforeEach(() => { fixture.profiles = []; fixture.commands = []; fixture.conflict = false; Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } }); });

it('creates a support profile with its mandate', async () => {
  const view = await render(<CallForSupportSettings baseUrl="https://relay.test" enabled hosts={hosts} />);
  await act(async () => {});
  expect(view.textContent).toContain('No support profiles yet.');
  await act(async () => button(view, 'New support profile').click());
  await type(field('Name'), 'Cross review');
  await type(field('Model', 1), 'opus');
  await act(async () => button(document, 'Create profile').click());
  expect(fixture.commands).toEqual([{ type: 'create', profile: { name: 'Cross review', description: '', coordinator: {}, enableByDefault: false,
    mandate: { supporters: [{ providerId: 'codex', model: 'opus' }], maxSupporters: 2, workspaces: ['shared'], remoteHosts: [], approval: 'every_roster' } } }]);
  expect(view.textContent).toContain('Cross review');
  expect(document.querySelector('dialog')).toBeNull();
});

it('refuses an incomplete profile before sending it', async () => {
  await render(<CallForSupportSettings baseUrl="https://relay.test" enabled hosts={hosts} />);
  await act(async () => button(document, 'New support profile').click());
  await type(field('Name'), 'Remote tests');
  await type(field('Model', 1), 'gpt-5.5');
  await act(async () => { const remote = [...document.querySelectorAll('label')].find(item => item.textContent === 'Remote Host')!.querySelector('input')!; remote.click(); });
  await act(async () => button(document, 'Create profile').click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('a repository for every remote Host');
  expect(fixture.commands).toEqual([]);
});

it('saves an edit with its revision and reloads after a conflict', async () => {
  fixture.profiles = [structuredClone(profile)];
  const view = await render(<CallForSupportSettings baseUrl="https://relay.test" enabled hosts={hosts} />);
  await act(async () => {});
  expect(view.textContent).toContain('you approve every roster');
  fixture.conflict = true;
  await act(async () => button(view, 'Edit').click());
  await type(field('Description'), 'Independent reviewers.');
  await act(async () => button(document, 'Save profile').click());
  expect(fixture.commands.at(-1)).toMatchObject({ type: 'update', id: 'review', revision: 3, profile: { description: 'Independent reviewers.' } });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('changed elsewhere');
  await act(async () => button(document, 'Save profile').click());
  expect(fixture.profiles[0]).toMatchObject({ description: 'Independent reviewers.', revision: 4 });
  await act(async () => button(view, 'Delete Cross review').click());
  await act(async () => button(view, 'Delete profile').click());
  expect(fixture.commands.at(-1)).toEqual({ type: 'delete', id: 'review', revision: 4 });
  expect(view.textContent).toContain('No support profiles yet.');
});
