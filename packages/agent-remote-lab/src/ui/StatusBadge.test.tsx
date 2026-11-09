import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { StatusBadge } from './StatusBadge.js';

it.each([
  [{ kind: 'attention', count: 2 } as const, 'Needs you: 2', '2'],
  [{ kind: 'failed' } as const, 'Failed', '!'],
  [{ kind: 'working' } as const, 'Working', ''],
  [{ kind: 'unread' } as const, 'New result', ''],
])('names the %o status for assistive technology', async (status, name, text) => {
  const container = await render(<StatusBadge status={status} />);
  const badge = container.querySelector('.ui-status') as HTMLElement;
  expect(badge.getAttribute('role')).toBe('img');
  expect(badge.getAttribute('aria-label')).toBe(name);
  expect(badge.dataset.kind).toBe(status.kind);
  expect(badge.textContent).toBe(text);
});

it('caps a large count', async () => {
  const container = await render(<StatusBadge status={{ kind: 'attention', count: 120 }} />);
  expect(container.querySelector('.ui-status')?.textContent).toBe('99+');
  expect(container.querySelector('.ui-status')?.getAttribute('aria-label')).toBe('Needs you: 120');
});

it.each([
  [99, 'Needs you: 99', '99'],
  [100, 'Needs you: 100', '99+'],
  [2.7, 'Needs you: 2', '2'],
] as const)('shows the count %s as "%s" with the name "%s"', async (count, name, text) => {
  const container = await render(<StatusBadge status={{ kind: 'attention', count }} />);
  const badge = container.querySelector('.ui-status') as HTMLElement;
  expect(badge.getAttribute('aria-label')).toBe(name);
  expect(badge.textContent).toBe(text);
});

it.each([0, -3, Number.NaN])('renders nothing for an attention count of %s', async count => {
  const container = await render(<StatusBadge status={{ kind: 'attention', count }} />);
  expect(container.querySelector('.ui-status')).toBeNull();
});
