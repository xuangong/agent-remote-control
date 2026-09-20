import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { DirectoryError } from '../directory-client.js';
import { SessionConnectionNotice, sessionConnectionFailure } from './SessionConnectionNotice.js';

it('shows an attach deadline as unconfirmed waiting with optional diagnostic details', async () => {
  const notice = sessionConnectionFailure(new DirectoryError('Relay timeout', 'session_attach_timeout', 504, 'request-1'), true);
  const container = await render(<SessionConnectionNotice notice={notice} />);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('may still be opening');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('Retrying automatically');
  expect(container.querySelector('details')?.open).toBe(false);
  expect(container.querySelector('details')?.textContent).toContain('session_attach_timeout');
  expect(container.querySelector('details')?.textContent).toContain('request-1');
});

it('keeps confirmed native failures distinct from waiting, including during automatic retry', async () => {
  const notice = sessionConnectionFailure(new DirectoryError('History deadline', 'native_history_timeout', 503), true);
  const container = await render(<SessionConnectionNotice notice={notice} />);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('reading session history');
  expect(container.textContent).not.toContain('may still be opening');
});

it('explains legacy Host timeouts in the context of opening an existing session', () => {
  expect(sessionConnectionFailure(new DirectoryError('outcome unknown', 'host_timeout', 504), false))
    .toMatchObject({ tone: 'status', message: expect.stringContaining('reopen the same session') });
});

it('offers daemon recovery only for a classified native file limit', async () => {
  const notice = sessionConnectionFailure(new DirectoryError('file limit', 'native_file_limit', 503), false);
  const container = await render(<SessionConnectionNotice notice={notice} />);
  expect(container.textContent).toContain('file descriptor');
  expect(container.textContent).toContain('Copy restart command');
});
