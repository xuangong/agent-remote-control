// @vitest-environment node
import { expect, it } from 'vitest';
import { registerAppShell, type AppShellHost } from './register.js';

function host(readyState: DocumentReadyState, workers: 'available' | 'refuses' | 'absent' = 'available') {
  const registered: Array<[string, RegistrationOptions]> = [];
  let load: (() => void) | undefined;
  const page: AppShellHost = {
    navigator: workers === 'absent' ? {} : { serviceWorker: { register: async (url, options) => {
      registered.push([url, options]);
      if (workers === 'refuses') throw new DOMException('Not allowed', 'SecurityError');
    } } },
    document: { readyState },
    addEventListener: (_type, listener) => { load = listener; },
  };
  return { page, registered, load: () => load?.() };
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
