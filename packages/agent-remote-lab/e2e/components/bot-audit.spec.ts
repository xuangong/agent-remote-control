// Component projects: webkit-mobile-viewport, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';

// The audit of the bots' work (bots design 7): each chain reads as its cause and what it set off, and the person stops a chain,
// one bot's part of it, pauses or resumes a standing bot, retires a temporary one, and sets thresholds, by pointer or keyboard,
// at any width without the page scrolling sideways.
const actions = (page: Page) => page.evaluate(() => (window as unknown as { auditActions: unknown[] }).auditActions);
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
  && [...document.querySelectorAll('.lab-bot-audit li')].every(row => row.getBoundingClientRect().right <= innerWidth && [...row.querySelectorAll('small, .lab-assistant-session-title')].every(part => { const box = part.getBoundingClientRect(); return box.width > 0 && box.right <= row.getBoundingClientRect().right + 1; })));

test('lists chains by cause, marks a stopped chain and a passed threshold, and acts on a chain and its bots', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/bot-audit.html');
  const audit = page.getByRole('main', { name: 'Audit' });
  await expect(audit.getByText('You asked Chief of staff').filter({ visible: true }).first()).toBeVisible();
  await expect(audit.getByText('Timer of Release tracker').filter({ visible: true }).first()).toBeVisible();
  await expect(audit.getByText('Passed: Tokens, Reply depth').filter({ visible: true }).first()).toBeVisible();
  await expect(audit.getByText('Stopped').filter({ visible: true }).first()).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('audit.png'), fullPage: true });

  await audit.locator('.lab-assistant-session-toggle').first().click();
  const first = audit.locator('.lab-bot-audit > ul > li').first();
  await expect(first.getByRole('button', { name: 'Stop Log reader here', exact: true })).toBeVisible();
  await first.getByRole('button', { name: 'Pause Release tracker', exact: true }).click();
  await expect(first.getByRole('button', { name: 'Resume Release tracker', exact: true })).toBeVisible();
  await first.getByRole('button', { name: 'Resume Release tracker', exact: true }).click();
  await first.getByRole('button', { name: 'Stop Log reader here', exact: true }).click();
  await first.getByRole('button', { name: 'Retire Log reader', exact: true }).click();
  await first.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(first.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  expect(await actions(page)).toEqual([
    { action: 'pause_bot', botId: 'b_' + '2'.repeat(32) }, { action: 'resume_bot', botId: 'b_' + '2'.repeat(32) },
    { action: 'stop_bot', chainId: 'c_0000000000000001', botId: 'b_' + '3'.repeat(32) }, { action: 'retire_bot', botId: 'b_' + '3'.repeat(32) },
    { action: 'stop', chainId: 'c_0000000000000001' },
  ]);
  expect(await fitsWidth(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('audit-acted.png'), fullPage: true });
});

test('lists what the person allowed for a chain and takes it back from the keyboard, at any width', async ({ page }) => {
  await page.goto('/e2e/fixtures/bot-audit.html');
  const audit = page.getByRole('main', { name: 'Audit' });
  await audit.locator('.lab-assistant-session-toggle').first().click();
  const approvals = audit.locator('.lab-bot-audit-approvals').filter({ visible: true });
  await expect(approvals).toContainText('Edit in /Users/someone/projects/agent-remote-control/packages/agent-remote-lab');
  await expect(approvals).toContainText('applied 3 times');
  expect(await fitsWidth(page)).toBe(true);
  await approvals.getByRole('button', { name: 'Ask me again', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(approvals).toHaveCount(0);
  expect(await actions(page)).toEqual([{ action: 'revoke_approval', chainId: 'c_0000000000000001', kind: 'Edit', cwd: '/Users/someone/projects/agent-remote-control/packages/agent-remote-lab' }]);
});

test('sets thresholds from the keyboard, and says when the bots have not worked together yet', async ({ page }) => {
  await page.goto('/e2e/fixtures/bot-audit.html?empty');
  const audit = page.getByRole('main', { name: 'Audit' });
  await expect(audit.getByText('Your bots have not worked together yet.')).toBeVisible();
  const inputs = audit.locator('form input');
  await expect(inputs.first()).toHaveValue('200000');
  await inputs.first().focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('150000');
  await page.keyboard.press('Tab');
  await page.keyboard.type('6');
  await inputs.nth(2).fill('45');
  await inputs.nth(2).press('Enter');
  await expect.poll(() => actions(page)).toEqual([{ action: 'set_thresholds', thresholds: { tokens: 150000, depth: 6, minutes: 45 } }]);
  expect(await fitsWidth(page)).toBe(true);
});
