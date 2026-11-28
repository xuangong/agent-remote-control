// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { render, rerender } from '../../test/setup.js';
import { PageCards, pageTime } from './PageCards.js';
import type { PageView } from '../TaskDirectory.js';

const page: PageView = { pageId: 'pg_0a1b2c3d4e5f', botId: 'b_tracker', bot: 'tracker', title: 'Launch tracker', contents: '| Task | Owner |\n|---|---|\n| Ship | tracker |', version: 1, updatedAt: Date.UTC(2026, 10, 28, 9, 30), team: true };

it('shows a team page as one closed card with its writer and time, and opens to the rendered table', async () => {
  const container = await render(<PageCards pages={[page]} />);
  const card = container.querySelector('[data-page-card]')!;
  expect(card.getAttribute('aria-label')).toBe('Page: Launch tracker');
  expect(card.textContent).toContain('Launch tracker');
  expect(card.textContent).toMatch(/Updated by tracker /);
  expect(card.querySelector('table')).toBeNull();
  await act(async () => card.querySelector<HTMLButtonElement>('button')!.click());
  expect(card.querySelector('table')?.textContent).toContain('Ship');
  expect(card.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
});

it('is updated in place: a rewrite changes the card where it stands, keeps it open and adds no card', async () => {
  const container = await render(<PageCards pages={[page]} />);
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  const first = container.querySelector('[data-page-card]')!;
  await rerender(container, <PageCards pages={[{ ...page, contents: '| Task | Owner |\n|---|---|\n| Ship | tracker |\n| Test | scout |', version: 2, updatedAt: page.updatedAt + 60_000 }]} />);
  const cards = container.querySelectorAll('[data-page-card]');
  expect(cards).toHaveLength(1);
  expect(cards[0]).toBe(first);
  expect(cards[0]!.textContent).toContain('Test');
  expect(cards[0]!.getAttribute('data-open')).toBe('true');
});

it('shows nothing without a page, and tells the time of today as a time and another day with its date', () => {
  const now = Date.UTC(2026, 10, 28, 12, 0);
  expect(pageTime(Date.UTC(2026, 10, 28, 9, 30), 'en', now)).toMatch(/\d{1,2}:30/);
  expect(pageTime(Date.UTC(2026, 10, 20, 9, 30), 'en', now)).toMatch(/Nov 20/);
});
