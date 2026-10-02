import { expect, test, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

async function createSide(page: Page) {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  const sourceUrl = page.url();
  await primary.getByTestId('prompt-input').fill('/side Keep this conversation');
  await primary.getByTestId('prompt-input').press('Enter');
  const side = page.getByRole('complementary', { name: 'Side conversation' });
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Keep this conversation');
  const takeover = side.getByRole('button', { name: 'Take control', exact: true });
  if (await takeover.isVisible()) await takeover.click();
  return { primary, side, sourceUrl, sideUrl: page.url() };
}

test('unlink persists after reload, allows Undo, and preserves the independent session', async ({ page }, info) => {
  const { sourceUrl, sideUrl } = await createSide(page);
  await page.goto(sourceUrl);
  const primary = page.locator('.lab-primary-conversation');
  const entries = primary.getByRole('navigation', { name: 'Forked sessions' });
  await expect(entries).toContainText('Sides · 1');
  await entries.getByRole('button', { name: /Actions for Side/ }).click();
  await page.screenshot({ path: `../../.tmp/evidence/unlink-menu-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('menuitem', { name: 'Unlink side session' }).click();
  await expect(entries).toHaveCount(0);
  await expect(page).toHaveURL(sourceUrl);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(entries).toContainText('Sides · 1');
  await entries.getByRole('button', { name: /Actions for Side/ }).click();
  await page.getByRole('menuitem', { name: 'Unlink side session' }).click();
  await expect(entries).toHaveCount(0);
  await page.reload();
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await expect(entries).toHaveCount(0);
  await page.goto(sideUrl);
  await expect(primary.locator('.agent-message-assistant').last()).toContainText('Keep this conversation');
  await expect(primary.locator('.lab-fork-reference')).toHaveCount(0);
  await expect(primary.getByTestId('timeline')).not.toContainText('<source-session-reference>');
});

test('unlinking from the side preserves its mounted view, draft and ongoing conversation', async ({ page }, info) => {
  const { primary, side, sideUrl } = await createSide(page);
  const input = side.getByTestId('prompt-input');
  const takeover = side.getByRole('button', { name: 'Take control', exact: true });
  if (await takeover.isVisible()) await takeover.click();
  await input.fill('Keep this unsent draft');
  const element = await input.elementHandle();
  const attachments: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/attach')) attachments.push(request.url()); });
  await side.locator('.lab-fork-reference summary').click();
  await side.getByRole('button', { name: 'Unlink side session', exact: true }).click();
  await expect(side.locator('.lab-fork-reference')).toHaveCount(0);
  await expect(side).toBeVisible();
  await expect(primary).toBeHidden();
  await expect(input).toHaveValue('Keep this unsent draft');
  expect(await element!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page).toHaveURL(sideUrl);
  if (info.project.name === 'chromium-mobile') await expect(page.locator('.lab-mobile-session-title')).toHaveText('Keep this conversation');
  expect(attachments).toEqual([]);
  await expect(side.getByRole('button', { name: 'Close side conversation' })).toHaveCount(0);
  await page.screenshot({ path: `../../.tmp/evidence/unlink-independent-${info.project.name}.png`, animations: 'disabled' });
  await input.press('Enter');
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Keep this unsent draft');
  await expect(side.getByTestId('timeline')).not.toContainText('<source-session-reference>');
});

test('unlinking a side retains its nested side and keeps the source independent', async ({ page }) => {
  const { primary, sourceUrl } = await createSide(page);
  const side = page.locator('.lab-side-conversation').filter({ has: page.locator('.lab-side-title-text', { hasText: 'Keep this conversation' }) });
  await side.getByTestId('prompt-input').fill('/side Nested conversation');
  await side.getByTestId('prompt-input').press('Enter');
  const nested = page.locator('.lab-side-conversation').filter({ has: page.locator('.lab-side-title-text', { hasText: 'Nested conversation' }) });
  await expect(nested.locator('.agent-message-assistant').last()).toContainText('Nested conversation');
  await nested.locator('.lab-fork-reference summary').click();
  await nested.getByRole('button', { name: 'Open source session', exact: true }).click();
  await side.locator('.lab-fork-reference summary').click();
  await side.getByRole('button', { name: 'Unlink side session', exact: true }).click();
  await expect(side.locator('.lab-fork-reference')).toHaveCount(0);
  await expect(side.getByRole('navigation', { name: 'Forked sessions' })).toContainText('Nested conversation');
  await expect(primary).toBeHidden();
  await side.getByRole('button', { name: 'Side 1 · Nested conversation', exact: true }).click();
  await expect(nested).toBeVisible();
  await page.goto(sourceUrl);
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await expect(primary.getByRole('navigation', { name: 'Forked sessions' })).toHaveCount(0);
});

test('creating another session after unlinking leaves the independent side', async ({ page }) => {
  const { side } = await createSide(page);
  await side.locator('.lab-fork-reference summary').click();
  await side.getByRole('button', { name: 'Unlink side session', exact: true }).click();
  await expect(side.locator('.lab-fork-reference')).toHaveCount(0);
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  await expect(primary.getByTestId('prompt-input')).toBeVisible();
  await primary.getByTestId('prompt-input').fill('A new independent topic');
  await primary.getByTestId('prompt-input').press('Enter');
  await expect(primary.locator('.agent-message-assistant').last()).toContainText('A new independent topic');
  await expect(side).toBeHidden();
});
