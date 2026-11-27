import { act } from 'react';
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { botGroup, mountBotApp, seedGroup, until } from './test/bot-mode-fixtures.js';
import { loadScreens } from './app/lazy-screens.js';

// Settings, the Trace and the Inspector are chunks the page warms when idle; a test opens them as a settled page would.
beforeAll(() => loadScreens());

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); history.replaceState(null, '', '/'); });

const viewport = (phone: boolean) => vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: phone ? query.includes('max-width: 1180px') || query.includes('max-width: 760px') : query.includes('min-width: 1181px'),
  media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
const group = (app: Awaited<ReturnType<typeof mountBotApp>>, title: string) => [...app.container.querySelectorAll<HTMLButtonElement>('.lab-settings-group')].find(item => item.querySelector('strong')?.textContent === title)!;

it('opens the computers from Settings > Computers in the rail, pairs from its head and opens a computer from its card', async () => {
  viewport(false);
  const scope = 'http://localhost/hosts-page/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.container.querySelector('.lab-rail')).not.toBeNull());
    await app.go('Settings');
    await act(async () => group(app, 'Computers').click());
    const page = () => app.container.querySelector<HTMLElement>('.lab-settings')!;
    expect(new URL(location.href).searchParams.get('group')).toBe('computers');
    const card = () => page().querySelector<HTMLElement>('[data-host-id="local"]')!;
    await until(() => expect(card().textContent).toContain('Test Host'));
    // The Hosts summary leads the group; the page is about machines, not where a session opens.
    expect(page().querySelector('.lab-host-lead')?.textContent).toBe('1 computer online');
    expect(page().querySelector('#remote-host')).toBeNull();
    expect(card().textContent).toContain('Update the Controller to see CPU, memory and disks.');
    const pair = page().querySelector<HTMLButtonElement>('.lab-host-overview-head .lab-host-pair')!;
    expect(pair.textContent).toBe('Pair a computer');
    await act(async () => pair.click());
    expect(page().querySelector('.lab-pairing-details')).not.toBeNull();
    await act(async () => card().querySelector<HTMLButtonElement>('.lab-host-open')!.click());
    expect(page().querySelector('.lab-host-page h2')?.textContent).toBe('Test Host');
  } finally { await app.close(); }
});

it('shows the computers under Me on a phone, with the summary on the Settings list', async () => {
  viewport(true);
  const scope = 'http://localhost/hosts-phone/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?mode=bot');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.container.querySelector('.lab-tab-bar')).not.toBeNull());
    await app.go('Settings');
    await until(() => expect(group(app, 'Computers').querySelector('small')?.textContent).toBe('1 computer online'));
    await act(async () => group(app, 'Computers').click());
    const overview = () => app.container.querySelector<HTMLElement>('section.lab-host-overview')!;
    await until(() => expect(overview().querySelector('[data-host-id="local"]')).not.toBeNull());
    expect(overview().querySelector<HTMLElement>('.lab-host-grid')?.dataset.compact).toBe('true');
  } finally { await app.close(); }
});
