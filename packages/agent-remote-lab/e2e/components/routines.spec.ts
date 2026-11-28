// Component projects: webkit-mobile-viewport, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';

// A bot's routines in its details and the unattended work settings (routines design 10): the rows read as schedule, next run, who set it and
// the last run; the person tests, pauses and deletes by pointer or keyboard, makes a routine from the form, and sets the budget, at any width
// without the page scrolling sideways.
const actions = (page: Page) => page.evaluate(() => (window as unknown as { routineActions: unknown[] }).routineActions);
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
  && [...document.querySelectorAll('.lab-routines-list li, .lab-unattended form')].every(row => row.getBoundingClientRect().right <= innerWidth + 1));

test('reads each routine as schedule, next run, who set it and its last run, and acts on it', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/routines.html');
  const routines = page.getByRole('main', { name: 'Routines' });
  const row = (name: string) => routines.locator(`li[data-routine="${name}"]`);
  await expect(row('Morning check')).toContainText('Weekdays at 08:30');
  await expect(row('Morning check')).toContainText('Over budget until the period ends');
  await expect(row('Morning check')).toContainText('Set by the bot');
  await expect(row('Morning check')).toContainText('Model claude-haiku-4-5');
  await expect(row('Morning check')).toContainText('2 missed runs included');
  await expect(row('Weekly summary')).toContainText('Paused');
  await expect(row('Deploy failed')).toContainText('2 events waiting');
  await expect(row('Deploy failed')).toContainText('Anyone with its address can start this');
  await expect(row('work')).toContainText('Automatic, while it has open work');
  await expect(row('work').getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await expect(routines.locator('li[data-routine^="Look at the failing build"]')).toContainText('skipped: over budget');
  expect(await fitsWidth(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('routines.png'), fullPage: true });

  await routines.getByRole('switch', { name: "Pause this bot's unattended work" }).click();
  await row('Morning check').getByRole('button', { name: 'Test', exact: true }).click();
  await row('Morning check').getByRole('button', { name: 'History', exact: true }).click();
  await expect(row('Morning check').locator('ol li')).toHaveCount(3);
  await row('Weekly summary').getByRole('button', { name: 'Resume', exact: true }).focus();
  await page.keyboard.press('Enter');
  await row('Quarter check').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row('Quarter check')).toHaveCount(0);
  expect(await actions(page)).toEqual([{ pauseBot: true }, { test: 'Morning check' }, { pause: ['Weekly summary', false] }, { remove: 'Quarter check' }]);
  expect(await fitsWidth(page)).toBe(true);
});

test('makes a routine from the form with native fields, from the keyboard, and says when there are none', async ({ page }) => {
  await page.goto('/e2e/fixtures/routines.html?empty');
  const routines = page.getByRole('main', { name: 'Routines' });
  await expect(routines.getByText('No routines.')).toBeVisible();
  await routines.getByRole('button', { name: 'New routine', exact: true }).click();
  const form = routines.getByRole('form', { name: 'New routine' });
  await form.getByLabel('Name').fill('Standup');
  await form.getByLabel('When').selectOption('daily');
  await form.getByLabel('Time').fill('09:15');
  await expect(form.getByLabel('Model').locator('option')).toHaveText(["Bot's own model", 'Default', 'Sonnet', 'Haiku']);
  await form.getByLabel('Model').selectOption('haiku');
  await form.getByLabel('What to do').fill('Summarise yesterday.');
  expect(await fitsWidth(page)).toBe(true);
  await form.getByLabel('Name').press('Enter');
  await expect(routines.locator('li[data-routine="Standup"]')).toContainText('Every day at 09:15');
  expect(await actions(page)).toEqual([{ save: { name: 'Standup', schedule: { kind: 'daily', time: '09:15' }, prompt: 'Summarise yesterday.', model: 'haiku' } }]);
});

test('makes a webhook routine with a warning, shows its address once with Copy, and replaces it from the row', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/routines.html?empty');
  const routines = page.getByRole('main', { name: 'Routines' });
  await routines.getByRole('button', { name: 'New routine', exact: true }).click();
  const form = routines.getByRole('form', { name: 'New routine' });
  await expect(form.getByLabel('When').locator('option')).toHaveText(['Every few minutes', 'Every day', 'On days', 'Once', 'After quiet', 'When a webhook is called']);
  await form.getByLabel('Name').fill('Deploy failed');
  await form.getByLabel('When').selectOption('event');
  await expect(form.getByRole('note')).toContainText('full permissions');
  expect(await fitsWidth(page)).toBe(true);
  await form.getByLabel('What to do').fill('Triage it.');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const row = routines.locator('li[data-routine="Deploy failed"]');
  await expect(row).toContainText('When its webhook is called');
  await expect(row).toContainText('read-only');
  await expect(row.getByRole('group', { name: 'Webhook address' })).toContainText('https://relay.example/hooks/ns/abc123abc123.' + 'y'.repeat(43));
  expect(await fitsWidth(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('webhook.png'), fullPage: true });
  await row.getByRole('button', { name: 'New address', exact: true }).click();
  await expect(row.getByRole('group', { name: 'Webhook address' })).toContainText('x'.repeat(43));
  expect((await actions(page)).length).toBe(2);
});

test('shows the budget, what was used, the cap reached and the provider window, and saves the caps', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/routines.html?settings');
  const settings = page.getByRole('main', { name: 'Unattended work' });
  await expect(settings.getByText('Today · ≈ $5.40')).toBeVisible();
  await expect(settings.getByText('Limit reached: all bots, today')).toBeVisible();
  await expect(settings.getByText('No price for: my-local-model')).toBeVisible();
  await expect(settings.getByText('claude: resumes')).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('unattended.png'), fullPage: true });
  const budget = settings.getByRole('form', { name: 'Budget' });
  await expect(budget.getByLabel('Per day')).toHaveValue('5');
  await budget.getByLabel('Per month').fill('80');
  await budget.getByLabel('Per month').press('Enter');
  await settings.getByRole('button', { name: 'Allow $5 more today' }).click();
  await expect.poll(() => actions(page)).toEqual([{ action: 'set_unattended', patch: { budget: { perDay: 5, perMonth: 80 } } }, { action: 'set_unattended', patch: { allowMoreToday: 5 } }]);
});
