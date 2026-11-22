import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpPreviewClient } from '@orchardworks/agent-client';
import { LocaleProvider } from '@orchardworks/agent-client-web/react';
import { bindAppearance, bindLanguage, bindMotion } from '@orchardworks/agent-client-web/browser';
import { render } from '../../test/setup.js';
import type { SettingsGroupId } from '../../kernel/destinations.js';
import { SettingsPage, type SettingsContext } from './SettingsPage.js';

const notifications = { enabled: true, available: true, permission: 'granted' as const, requestFailed: false, request: vi.fn(), set: vi.fn(),
  push: { availability: 'unsupported' as const, status: 'off' as const, enable: vi.fn(), disable: vi.fn() } };
const context = (overrides: Partial<SettingsContext> = {}): SettingsContext => ({
  facts: { account: true, supportAvailable: false, notificationsAvailable: true }, account: { name: 'Xian', email: 'xian@example.com', ready: true, openSecurity: vi.fn(), signOut: vi.fn() }, baseUrl: 'http://localhost/',
  notifications, openTrace: vi.fn(), openInspector: vi.fn(),
  computers: { hosts: [{ id: 'studio', name: 'Studio', online: true }], loaded: true, service: { hosts: async () => ({ hosts: [] }), pair: async () => { throw new Error('unused'); } },
    previewClient: new HttpPreviewClient('http://localhost/'), tunnelService: { status: async () => { throw new Error('unused'); }, start: async () => { throw new Error('unused'); }, stop: async () => { throw new Error('unused'); } }, openPreviewSource: () => undefined, onRevoked: () => undefined },
  ...overrides });

/** The page over device choices bound to this document, the way the Lab binds them once before it renders. */
function Harness({ phone = false, initial, ctx = context() }: { phone?: boolean; initial?: SettingsGroupId; ctx?: SettingsContext }) {
  const [group, setGroup] = useState<SettingsGroupId | undefined>(initial);
  return <SettingsPage context={ctx} group={group} phone={phone} onGroup={setGroup} />;
}
let choices: ReturnType<typeof bind> | undefined;
function bind() { return { appearance: bindAppearance(document, localStorage, window), language: bindLanguage(document, localStorage, window), motion: bindMotion(document, localStorage, window) }; }
vi.mock('../../kernel/device-choices.js', () => ({ deviceChoices: () => choices! }));
afterEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme; delete document.documentElement.dataset.motion; document.documentElement.lang = ''; vi.unstubAllGlobals(); });
const mount = (node: React.ReactNode, lang = 'en') => { vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })); choices = bind(); return render(<LocaleProvider language={choices.language}>{node}</LocaleProvider>); };
const press = async (root: ParentNode, label: string) => act(async () => ([...root.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label || item.querySelector('strong')?.textContent === label) as HTMLButtonElement).click());

it('lists the six groups in order beside the chosen one, General when none is chosen, each from the facts', async () => {
  const container = await mount(<Harness />);
  expect([...container.querySelectorAll('.lab-settings-group strong')].map(item => item.textContent)).toEqual(['General', 'Assistants', 'Computers', 'Privacy and data', 'Advanced', 'Account and about']);
  expect(container.querySelector('.lab-settings h1')?.textContent).toBe('General');
  expect(container.querySelector('.lab-settings-group[aria-current="page"] strong')?.textContent).toBe('General');
  await press(container, 'Assistants');
  expect(container.querySelector('.lab-settings h1')?.textContent).toBe('Assistants');
});

it('shows a signed-out device no account, security or sign out, and a device that cannot notify no notifications', async () => {
  const container = await mount(<Harness initial="account" ctx={context({ facts: { account: false, supportAvailable: false, notificationsAvailable: false }, account: undefined })} />);
  expect(container.textContent).not.toContain('Sign out');
  expect(container.textContent).toContain('Versions');
  await press(container, 'Assistants');
  expect(container.textContent).not.toContain('When an assistant finishes or needs you');
});

it('applies each general choice at once: Theme sets data-theme, Language re-renders in Chinese, Reduce motion sets data-motion', async () => {
  const container = await mount(<Harness />);
  const group = (name: string) => container.querySelector<HTMLElement>(`[role="group"][aria-label="${name}"]`)!;
  await press(group('Theme'), 'Dark');
  expect(document.documentElement.dataset.theme).toBe('dark'); expect(localStorage.getItem('agent-remote:appearance')).toBe('dark');
  await press(group('Language'), '中文');
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(container.querySelector('.lab-settings h1')?.textContent).toBe('通用');
  expect(container.textContent).toContain('减少动效');
  const motion = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(item => item.textContent === '减少动效')!;
  await act(async () => motion.click());
  expect(document.documentElement.dataset.motion).toBe('reduce'); expect(motion.getAttribute('aria-checked')).toBe('true');
});

it('locks Reduce motion on, with its note, while the system reduces motion', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query, addEventListener() {}, removeEventListener() {} }));
  choices = bind();
  const container = await render(<LocaleProvider language={choices.language}><Harness /></LocaleProvider>);
  const motion = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(item => item.textContent === 'Reduce motion')!;
  expect([motion.disabled, motion.getAttribute('aria-checked')]).toEqual([true, 'true']);
  expect(container.textContent).toContain('Your system already asks for less motion.');
});

it('stores the default view, which the next open reads', async () => {
  const container = await mount(<Harness />);
  const group = container.querySelector<HTMLElement>('[role="group"][aria-label="Default view"]')!;
  await press(group, 'Chats');
  expect(localStorage.getItem('agent-remote:default-view')).toBe('chats');
  await press(group, 'Last used');
  expect(localStorage.getItem('agent-remote:default-view')).toBeNull();
});

it('writes the device process default, notifications and team messages of the Assistants group', async () => {
  const container = await mount(<Harness initial="assistants" />);
  await press(container.querySelector<HTMLElement>('[role="group"][aria-label="Default process display"]')!, 'Full');
  expect(localStorage.getItem('agent-remote:process-mode')).toBe('full');
  await press(container, 'Notifications');
  expect(notifications.set).toHaveBeenCalledWith(false);
  await press(container, 'Team messages');
  expect(localStorage.getItem('agent-remote:show-letters')).toBe('false');
});

it('on the phone shows Me with the account and the list, drills into a group and goes back', async () => {
  const container = await mount(<Harness phone />);
  expect(container.querySelector('.lab-settings-me h1')?.textContent).toBe('Me');
  expect(container.querySelector('.lab-settings-account')?.textContent).toContain('Xian');
  expect(container.querySelector('.lab-settings-group-text small')?.textContent).toBe('Theme, language, default view');
  await press(container, 'Advanced');
  expect(container.querySelector('.lab-settings h1')?.textContent).toBe('Advanced');
  await press(container, 'Back');
  expect(container.querySelector('.lab-settings-me')).not.toBeNull();
});

it('opens Trace and the Replica Inspector from Advanced, and signs out from Account', async () => {
  const ctx = context();
  const container = await mount(<Harness initial="advanced" ctx={ctx} />);
  const row = (label: string) => [...container.querySelectorAll('.lab-setting-row')].find(item => item.textContent?.includes(label))!;
  await press(row('Open Trace'), 'Open'); expect(ctx.openTrace).toHaveBeenCalledOnce();
  await press(row('Show Replica Inspector'), 'Show'); expect(ctx.openInspector).toHaveBeenCalledOnce();
  await press(container, 'Account and about');
  await press(container, 'Sign out'); expect(ctx.account!.signOut).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Signed in as Xian');
  expect(container.textContent).toContain('Controller on Studio');
});
