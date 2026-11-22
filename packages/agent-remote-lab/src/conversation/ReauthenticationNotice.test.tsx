import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { ReauthenticationNotice } from './ReauthenticationNotice.js';

it('requests a fresh site sign-in without naming an authentication provider', async () => {
  const view = await render(<ReauthenticationNotice />);
  expect(view.querySelector('[role="alert"]')?.textContent).toContain('A recent sign-in is required. Try the action again after signing in; it will not run automatically.');
  expect(view.textContent).not.toMatch(/gateway/i);
  const link = view.querySelector('a')!;
  expect(link.textContent).toBe('Sign in again');
  expect(link.getAttribute('href')).toBe('/auth/login?reauthenticate=1');
});
