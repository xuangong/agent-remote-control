import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionDirectoryClient, DirectoryError } from './directory-client.js';
import { botGroup, mountBotApp, seedGroup, until, visibleButton } from './test/bot-mode-fixtures.js';

// Stage 7: a session its Host reported missing is not asked for again by what the page does around it (see the stage 7 plan).
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it('asks for a missing session once across mode switches, state frames, bot switches, page resumes and an access pause', { timeout: 60_000 }, async () => {
  const scope = 'http://localhost/u/attach-budget/';
  seedGroup(scope, botGroup('G'));
  history.replaceState(null, '', '/?window=G');
  const asked: string[] = [];
  // Directories other than the App's own (each view may make one for its Host).
  vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockImplementation(async (_provider, nativeSessionId) => {
    asked.push(nativeSessionId);
    if (nativeSessionId === 'G2') throw new DirectoryError('The native runtime could not find this session.', 'native_session_unavailable', 404);
    return { agentId: `agent-${nativeSessionId}`, nativeSessionId };
  });
  const app = await mountBotApp(scope, { hosted: true, missing: ['G2'] });
  const missing = () => [...asked, ...app.attachments].filter(id => id === 'G2').length;
  await until(() => expect(missing()).toBeGreaterThanOrEqual(1));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
  // The Window's binding and its conversation open the selected view together, so a page asks at most twice as it loads.
  const first = missing();
  expect(first).toBeLessThanOrEqual(2);

  await app.switchMode('bot');
  await until(() => expect(app.container.querySelectorAll('nav[aria-label="Assistants"] .lab-bot-row').length).toBeGreaterThanOrEqual(2));
  for (let index = 0; index < 10; index++) await act(async () => app.emitStates({ hosts: [{ hostId: 'local', online: true }],
    states: [{ hostId: 'local', providerId: 'recorded', nativeSessionId: 'G1', state: index % 2 ? 'idle' : 'running', ageMs: 0 }] }));
  for (let index = 0; index < 3; index++) {
    await act(async () => visibleButton(app.container, 'G1').click());
    await act(async () => visibleButton(app.container, 'G2').click());
  }
  await app.switchMode('window');
  await app.switchMode('bot');
  for (const state of ['hidden', 'visible'] as const) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  }
  await act(async () => window.dispatchEvent(new Event('online')));
  await act(async () => app.setAccessReady(false));
  await act(async () => app.setAccessReady(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  expect(missing()).toBe(first);

  // An explicit Retry asks again.
  const retry = [...app.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Retry' && !button.closest('[hidden]'));
  expect(retry, app.container.textContent ?? '').toBeDefined();
  await act(async () => retry!.click());
  await until(() => expect(missing()).toBe(first + 1));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await app.close();
});
