import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../../test/setup.js';
import { PagesList } from './PagesList.js';
import { PrimaryControl } from './PrimaryControl.js';

const page = { pageId: 'pg_0a1b2c3d4e5f', botId: 'b_' + '1'.repeat(32), bot: 'Chief', title: 'Launch tracker', contents: '| Task | Owner |\n|---|---|\n| Ship | tracker |', version: 2, updatedAt: Date.now() - 60_000, team: true as const };

it('lists a bot\'s pages read only, marks the team page, and opens one to its table', async () => {
  const container = await render(<PagesList pages={[page, { ...page, pageId: 'pg_111111111111', title: 'Notes', contents: 'Plain.', team: undefined as never }]} />);
  const rows = [...container.querySelectorAll('[data-pages] > li')];
  expect(rows.map(row => row.querySelector('.lab-assistant-session-title')!.textContent)).toEqual(['Launch tracker', 'Notes']);
  expect(rows[0]!.textContent).toContain('Team page');
  expect(rows[1]!.textContent).not.toContain('Team page');
  expect(container.querySelector('textarea, input')).toBeNull();
  await act(async () => rows[0]!.querySelector<HTMLButtonElement>('button')!.click());
  expect(rows[0]!.querySelector('table')?.textContent).toContain('Ship');
});

it('offers Make primary to a bot that reports to the person, Clear to the primary bot, and nothing to a bot that reports to another bot', async () => {
  const set = vi.fn(async () => {});
  const eligible = await render(<PrimaryControl primary={{ current: false, eligible: true, set }} />);
  await act(async () => eligible.querySelector<HTMLButtonElement>('button')!.click());
  expect(set).toHaveBeenLastCalledWith(true);
  const current = await render(<PrimaryControl primary={{ current: true, eligible: true, set }} />);
  expect(current.textContent).toContain('This is your primary bot.');
  await act(async () => current.querySelector<HTMLButtonElement>('button')!.click());
  expect(set).toHaveBeenLastCalledWith(false);
  const refused = await render(<PrimaryControl primary={{ current: false, eligible: false, set }} />);
  expect(refused.querySelector('button')).toBeNull();
  expect(refused.textContent).toContain('Only a bot that reports to you can be primary.');
});

it('says why a refused change failed and lets the person try again', async () => {
  const set = vi.fn(async () => { throw new Error('Only a bot that reports to you can be primary.'); });
  const container = await render(<PrimaryControl primary={{ current: false, eligible: true, set }} />);
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Only a bot that reports to you');
  expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
});
