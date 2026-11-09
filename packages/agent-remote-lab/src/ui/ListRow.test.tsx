import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { ListRow } from './ListRow.js';

it('lays out a picture, title, subtitle and trailing accessory in one button', async () => {
  const onClick = vi.fn();
  const container = await render(<ListRow leading={<span data-testid="pic" />} title="API caching" subtitle="Backend review"
    trailing={<span data-testid="badge" />} selected onClick={onClick} data-bot-place="x" />);
  const row = container.querySelector('button')!;
  expect(row.className).toBe('ui-list-row');
  expect(row.getAttribute('aria-current')).toBe('true');
  expect(row.dataset.botPlace).toBe('x');
  expect(row.querySelector('.ui-list-row-title')?.textContent).toBe('API caching');
  expect(row.querySelector('.ui-list-row-subtitle')?.textContent).toBe('Backend review');
  expect(row.querySelector('[data-testid="pic"]')).not.toBeNull();
  expect(row.querySelector('[data-testid="badge"]')).not.toBeNull();
  await act(async () => row.click());
  expect(onClick).toHaveBeenCalledOnce();
});

it('leaves out what a row does not have', async () => {
  const container = await render(<ListRow title="Release notes" />);
  const row = container.querySelector('button')!;
  expect(row.hasAttribute('aria-current')).toBe(false);
  expect(row.querySelector('.ui-list-row-subtitle')).toBeNull();
  expect(row.querySelector('.ui-list-row-leading')).toBeNull();
});
