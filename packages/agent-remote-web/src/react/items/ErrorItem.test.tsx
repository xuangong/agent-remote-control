import { act } from 'react';
import { expect, it } from 'vitest';
import { render, rerender } from '../../test/setup.js';
import { ErrorItem } from './ErrorItem.js';

it('keeps runtime diagnostics quiet and discloses their complete text on request', async () => {
  const message = 'azure failed: MCP startup timed out.\nAdjust startup_timeout_sec in config.toml. <script>not markup</script>';
  const container = await render(<ErrorItem item={{ type: 'error', message }} />);
  const toggle = container.querySelector('button')!;
  const details = container.querySelector('p')!;
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-controls')).toBe(details.id);
  expect(details.hidden).toBe(true);
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(details.hidden).toBe(false);
  expect(details.textContent).toBe(message);
  expect(container.querySelector('script')).toBeNull();
  await rerender(container, <ErrorItem item={{ type: 'error', message: `${message}\nAdditional detail.` }} />);
  expect(container.querySelector('p')?.hidden).toBe(false);
  await act(async () => toggle.click());
  expect(details.hidden).toBe(true);
});
