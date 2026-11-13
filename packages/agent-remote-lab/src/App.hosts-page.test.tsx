import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { botGroup, mountBotApp, seedGroup, until, visibleButton } from './test/bot-mode-fixtures.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); history.replaceState(null, '', '/'); });

const viewport = (phone: boolean) => vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: phone ? query.includes('max-width: 1180px') : query.includes('min-width: 1181px'),
  media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));

it('opens Hosts from the desktop sidebar footer, pairs from its toolbar and opens a Host from its card', async () => {
  viewport(false);
  const scope = 'http://localhost/hosts-page/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    const footer = () => app.container.querySelector('#lab-context footer.lab-sidebar-footer')!;
    await until(() => expect(footer().querySelector('.lab-sidebar-hosts')?.textContent).toBe('1 Host online'));
    await act(async () => footer().querySelector<HTMLButtonElement>('.lab-sidebar-hosts')!.click());
    const page = app.container.querySelector<HTMLElement>('#lab-sessions-page')!;
    expect(page.hidden).toBe(false);
    expect(page.getAttribute('aria-label')).toBe('Hosts');
    expect(footer().querySelector('.lab-sidebar-hosts')?.getAttribute('aria-current')).toBe('page');
    // The page is about machines, not where a session opens, and the Host select stays in Settings.
    expect(page.querySelector('.lab-session-open-target')).toBeNull();
    expect(page.querySelector('#remote-host')).toBeNull();
    const card = () => page.querySelector<HTMLElement>('[data-host-id="local"]')!;
    await until(() => expect(card().textContent).toContain('Test Host'));
    expect(card().textContent).toContain('Update the Controller to see CPU, memory and disks.');
    const pair = page.querySelector<HTMLButtonElement>('.lab-sessions-page-toolbar .lab-host-pair')!;
    expect(pair.textContent).toBe('Pair a Host');
    await act(async () => pair.click());
    expect(page.querySelector('.lab-pairing-details')).not.toBeNull();
    await act(async () => card().querySelector<HTMLButtonElement>('.lab-host-open')!.click());
    expect(page.getAttribute('aria-label')).toBe('Settings');
    expect(page.querySelector<HTMLSelectElement>('#remote-host')?.value).toBe('local');
  } finally { await app.close(); }
});

it('shows Hosts as a sidebar section on a phone', async () => {
  viewport(true);
  const scope = 'http://localhost/hosts-phone/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(visibleButton(app.container, 'Open sessions')).toBeDefined());
    await act(async () => visibleButton(app.container, 'Open sessions').click());
    const sections = () => app.container.querySelector('nav[aria-label="Sidebar sections"]')!;
    await until(() => expect(sections()).not.toBeNull());
    expect([...sections().querySelectorAll('button')].map(button => button.textContent)).toEqual(['Sessions', 'Favorites', 'Hosts', 'Settings']);
    await act(async () => visibleButton(sections(), 'Hosts').click());
    const overview = () => app.container.querySelector<HTMLElement>('section.lab-host-overview')!;
    await until(() => expect(overview().querySelector('[data-host-id="local"]')).not.toBeNull());
    expect(overview().querySelector('.lab-directory-heading h2')?.textContent).toBe('Hosts');
    expect(overview().querySelector('.lab-directory-heading .lab-host-pair')).not.toBeNull();
    expect(overview().querySelector<HTMLElement>('.lab-host-grid')?.dataset.compact).toBe('true');
  } finally { await app.close(); }
});
