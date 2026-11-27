// @vitest-environment node
import { expect, it } from 'vitest';
import { registerAppShell, UPDATE_CHECK_INTERVAL_MS, type AppShellHost } from './register.js';

function host(readyState: DocumentReadyState, workers: 'available' | 'refuses' | 'absent' = 'available') {
  const registered: Array<[string, RegistrationOptions]> = [];
  const listeners = new Map<string, () => void>();
  const state = { visibility: 'visible' as DocumentVisibilityState, updates: 0 };
  const page: AppShellHost = {
    navigator: workers === 'absent' ? {} : { serviceWorker: { register: async (url, options) => {
      registered.push([url, options]);
      if (workers === 'refuses') throw new DOMException('Not allowed', 'SecurityError');
      return { update: async () => { state.updates += 1; } };
    } } },
    document: { readyState, get visibilityState() { return state.visibility; } },
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
  };
  return { page, registered, state, load: () => listeners.get('load')?.(), visibilityChange: () => listeners.get('visibilitychange')?.() };
}

it('registers the worker for the whole site once the page has loaded, bypassing the HTTP cache for its updates', () => {
  const loading = host('loading');
  registerAppShell(loading.page, true);
  expect(loading.registered).toEqual([]);
  loading.load();
  expect(loading.registered).toEqual([['/sw.js', { scope: '/', updateViaCache: 'none' }]]);
  const loaded = host('complete');
  registerAppShell(loaded.page, true);
  expect(loaded.registered).toHaveLength(1);
});

it('registers nothing in a development build or where the browser has no service workers, and a refusal changes nothing', async () => {
  const development = host('complete');
  registerAppShell(development.page, false);
  expect(development.registered).toEqual([]);
  expect(() => registerAppShell(host('complete', 'absent').page, true)).not.toThrow();
  const refusing = host('complete', 'refuses');
  registerAppShell(refusing.page, true);
  await Promise.resolve();
  expect(refusing.registered).toHaveLength(1);
});

it('asks for a new build when the app comes back to the front, at most every quarter of an hour, and never from the background', async () => {
  const app = host('complete');
  let clock = 0;
  registerAppShell(app.page, true, () => clock);
  await Promise.resolve();
  app.visibilityChange();
  expect(app.state.updates).toBe(0);
  clock = UPDATE_CHECK_INTERVAL_MS;
  app.state.visibility = 'hidden';
  app.visibilityChange();
  expect(app.state.updates).toBe(0);
  app.state.visibility = 'visible';
  app.visibilityChange();
  expect(app.state.updates).toBe(1);
  clock += 60_000;
  app.visibilityChange();
  expect(app.state.updates).toBe(1);
  clock += UPDATE_CHECK_INTERVAL_MS;
  app.visibilityChange();
  expect(app.state.updates).toBe(2);
});
