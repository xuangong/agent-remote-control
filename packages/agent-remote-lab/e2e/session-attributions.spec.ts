import { expect, test, type Locator } from '@playwright/test';
import { showNewSession } from './session-navigation';

async function expand(view: Locator) {
  const toggle = view.getByRole('button', { name: 'Show session attributions', exact: true });
  await expect(toggle).toBeAttached();
  const actions = view.getByRole('button', { name: 'Expand session actions', exact: true });
  if (await actions.isVisible()) await actions.click();
  await toggle.click();
  return view.getByRole('table', { name: 'Session attributions' });
}

test('Ask and Side expose their source inline and navigate without replacing other views', async ({ page, isMobile }, testInfo) => {
  if (!isMobile) await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation').first();
  const input = primary.getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  await input.fill('/ask Discuss the acceptance criteria'); await input.press('Enter');
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await ask.getByTestId('prompt-input').fill('Keep this draft');
  const askTable = await expand(ask);
  await expect(askTable.getByRole('row', { name: 'Role Ask', exact: true })).toBeVisible();
  await expect(askTable.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Main', exact: true }) })).toContainText('New session');
  await expect(ask.getByTestId('prompt-input')).toHaveText('Keep this draft');
  const bounds = await askTable.boundingBox();
  const timelineBounds = await ask.getByTestId('timeline').boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(timelineBounds!.y + 1);
  await page.screenshot({ path: testInfo.outputPath('ask-attributions.png'), animations: 'disabled' });
  await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  await input.fill('/side Investigate the implementation'); await input.press('Enter');
  const side = page.getByRole('complementary', { name: 'Side conversation' });
  await expect(side.getByTestId('prompt-input')).toBeEnabled();
  const sideTable = await expand(side);
  await expect(sideTable.getByRole('row', { name: 'Role Side', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('side-attributions.png'), animations: 'disabled' });
  const paneCount = await page.locator('[data-view-id]').count();
  // The recorded local directory has no fixed SourceBinding; this link reuses the live source view.
  await sideTable.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Source', exact: true }) }).getByRole('button').click();
  await expect(primary).toBeVisible();
  await expect(page.locator('[data-view-id]')).toHaveCount(paneCount);
  if (!isMobile) await expect(side).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  const mainTable = await expand(primary);
  await expect(mainTable.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Ask', exact: true }) })).toBeVisible();
  await mainTable.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Ask', exact: true }) }).getByRole('button').click();
  await expect(ask).toBeVisible();
  await expect(ask.getByTestId('prompt-input')).toHaveText('Keep this draft');
});
