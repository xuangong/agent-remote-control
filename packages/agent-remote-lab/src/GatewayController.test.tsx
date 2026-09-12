import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from './test/setup.js';
import { GatewayController } from './GatewayController.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('offers gateway login without loading private controllers when the grant is missing', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Sign in' }, { status: 401 })));
  const view = await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
  expect(view.querySelector('a')?.getAttribute('href')).toBe('/auth/login');
  expect(view.textContent).not.toContain('Private controller');
});
it('uses a user-scoped controller URL and retires the controller at grant expiry', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 5000 })));
  const view = await render(<GatewayController>{baseUrl => <p>{baseUrl}</p>}</GatewayController>);
  expect(view.textContent).toContain(window.location.origin + '/u/' + 'a'.repeat(64) + '/');
  await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
  expect(view.querySelector('a')?.textContent).toBe('Sign in through gateway');
});
